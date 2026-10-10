import { expect, test } from "bun:test"
import { isCommandWord } from "../src/agent/words"
import { assistant, session } from "./support"
import { agent, document, permission, question, user, world } from "./agent-fixture"

const noContent = () => new Response(null, { status: 204 })
const notFound = () => Response.json({ _tag: "SessionNotFoundError", message: "gone" }, { status: 404 })

/** A server that answers the writes the commands make, and remembers each answer it was given. */
function answering() {
  const replies: { path: string; body: unknown }[] = []
  const record = (path: string) => async (request: Request) => {
    replies.push({ path, body: await request.text().then((text) => (text ? JSON.parse(text) : undefined)) })
    return noContent()
  }
  const server = world({
    "POST /api/session/ses_main/permission/per_1/reply": record("per_1/reply"),
    "POST /api/session/ses_main/question/que_1/reply": record("que_1/reply"),
    "POST /api/session/ses_main/question/que_1/reject": record("que_1/reject"),
    "POST /api/session/ses_main/interrupt": record("interrupt"),
    "GET /api/session/ses_unknown": notFound,
    "GET /api/session/ses_x/permission": notFound,
    "GET /api/session/ses_x/question": notFound,
    "POST /api/session": async (request) => {
      const body = (await request.json()) as { id: string; location: unknown }
      return { data: { ...session("new"), id: body.id, location: body.location } }
    },
    "POST /api/session/ses_fresh/prompt": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_fresh" },
    }),
  })
  return { server, replies }
}

const colour = (custom: boolean) =>
  question("que_1", {
    questions: [
      {
        header: "Pick a colour",
        question: "Which colour?",
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cool" },
        ],
        custom,
      },
    ],
  })

test("answer --choice refuses a near miss of an option and sends nothing", async () => {
  const { server, replies } = answering()
  server.state.questions.push(colour(true))
  const result = await agent(["answer", "ses_main", "que_1", "--choice", "Rd"], { url: server.url })
  expect(result.code).toBe(2)
  expect(result.stderr).toBe('turen-tui: Did you mean "Red"? Add --custom to send "Rd" as typed.\n')
  // Case does not hide it, and --answers takes the same check.
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "blu"], { url: server.url })).code).toBe(2)
  expect((await agent(["answer", "ses_main", "que_1", "--answers", '[["Rd"]]'], { url: server.url })).code).toBe(2)
  expect(replies).toEqual([])
})

test("answer --custom sends a near miss as typed, and an exact label or a distant answer needs no flag", async () => {
  const { server, replies } = answering()
  server.state.questions.push(colour(true))
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "Rd", "--custom"], { url: server.url })).code).toBe(0)
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "red"], { url: server.url })).code).toBe(2)
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "Red"], { url: server.url })).code).toBe(0)
  const distant = await agent(["answer", "ses_main", "que_1", "--choice", "Turquoise"], { url: server.url })
  expect(distant.code).toBe(0)
  expect(distant.stderr).toContain("sent as a custom answer")
  expect(replies.map((reply) => reply.body)).toEqual([
    { answers: [["Rd"]] },
    { answers: [["Red"]] },
    { answers: [["Turquoise"]] },
  ])
})

test("answer keeps its refusal of any non-option when the question allows no custom answer", async () => {
  const { server, replies } = answering()
  server.state.questions.push(colour(false))
  const result = await agent(["answer", "ses_main", "que_1", "--choice", "Rd", "--custom"], { url: server.url })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('"Rd" is not an option for question 1. Valid choices: Red | Blue.')
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "Rd"], { url: server.url })).stderr).toContain(
    "is not an option",
  )
  expect(replies).toEqual([])
})

test("stop on an unknown session fails like the other commands, and an idle session was not running", async () => {
  const { server, replies } = answering()
  const unknown = await agent(["stop", "ses_unknown"], { url: server.url })
  expect(unknown.code).toBe(1)
  expect(unknown.stderr).toBe("turen-tui: No session ses_unknown on this server.\n")
  expect(unknown.stdout).toBe("")
  expect(replies).toEqual([])
  expect((await agent(["stop", "ses_main"], { url: server.url })).stdout).toBe("ses_main was not running\n")
})

test("approve, reject and answer on an unknown session say so, like show", async () => {
  const { server } = answering()
  for (const args of [
    ["approve", "ses_x", "per_1"],
    ["reject", "ses_x", "per_1"],
    ["answer", "ses_x", "que_1", "--reject"],
  ]) {
    const result = await agent(args, { url: server.url })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("turen-tui: No session ses_x on this server.\n")
  }
})

test("a write names the command that waits for the session, with the run's server flags", async () => {
  const { server } = answering()
  server.state.permissions.push(permission("per_1"))
  const approved = await agent(["approve", "ses_main", "per_1", "--url", server.url], {})
  expect(approved.stdout).toBe(
    `approved per_1 (once) · session ses_main\n  wait: turen-tui wait ses_main --url "${server.url}"\n`,
  )
  server.state.questions.push(colour(true))
  const answered = await agent(["answer", "ses_main", "que_1", "--choice", "Red"], { url: server.url })
  expect(answered.stdout).toBe("answered que_1\n  wait: turen-tui wait ses_main\n")
  // The JSON carries the session ID instead of the text line.
  expect(document(await agent(["reject", "ses_main", "per_1", "--json"], { url: server.url }))).not.toHaveProperty(
    "wait",
  )
})

test("every JSON document that identifies a session carries sessionID beside its old keys", async () => {
  const { server } = answering()
  server.state.permissions.push(permission("per_1"))
  server.state.messages.push(user("q", "hi"))
  const json = async (args: string[]) => document(await agent([...args, "--json"], { url: server.url }))

  const listed = (await json(["sessions"])).sessions as Record<string, unknown>[]
  expect(listed[0]).toMatchObject({ id: "ses_main", sessionID: "ses_main", parentID: null, state: "idle" })
  // Only a running session is asked what it waits for, so the pending permission shows from show on.
  const waiting = { session: "ses_main", sessionID: "ses_main", state: "needs-input" }
  expect(await json(["show", "ses_main"])).toMatchObject(waiting)
  expect(await json(["wait", "ses_main"])).toMatchObject(waiting)
  expect(await json(["send", "ses_main", "hello"])).toMatchObject({
    session: "ses_main",
    sessionID: "ses_main",
    state: "sent",
    delivery: "steer",
    created: false,
  })
  expect(await json(["send", "--new", "hello", "--session-id", "ses_fresh"])).toMatchObject({
    session: "ses_fresh",
    sessionID: "ses_fresh",
    created: true,
  })
  const pending = (await json(["pending", "ses_main"])).permissions as Record<string, unknown>[]
  expect(pending[0]).toMatchObject({ id: "per_1", sessionID: "ses_main" })
  expect(await json(["approve", "ses_main", "per_1"])).toEqual({
    ok: true,
    session: "ses_main",
    sessionID: "ses_main",
    permission: "per_1",
    reply: "once",
  })
  expect(await json(["reject", "ses_main", "per_1"])).toMatchObject({ session: "ses_main", sessionID: "ses_main" })
  server.state.questions.push(colour(true))
  expect(await json(["answer", "ses_main", "que_1", "--choice", "Red"])).toEqual({
    ok: true,
    session: "ses_main",
    sessionID: "ses_main",
    question: "que_1",
    answers: [["Red"]],
  })
  expect(await json(["stop", "ses_main"])).toEqual({
    ok: true,
    session: "ses_main",
    sessionID: "ses_main",
    running: false,
  })
})

test("wait and send --wait both carry the finished reply as message, and send keeps messages", async () => {
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      server.state.messages.push(user(body.id.slice(4), body.prompt.text), assistant("done", "all done"))
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const sent = document(await agent(["send", "ses_main", "go", "--wait", "--json"], { url: server.url }))
  const waited = document(await agent(["wait", "ses_main", "--json"], { url: server.url }))
  expect(waited).toMatchObject({ session: "ses_main", sessionID: "ses_main", state: "idle" })
  expect(sent).toMatchObject({ session: "ses_main", sessionID: "ses_main", state: "idle" })
  expect((sent.message as { id: string }).id).toBe("msg_done")
  expect((waited.message as { id: string }).id).toBe("msg_done")
  expect((sent.messages as { id: string }[]).map((message) => message.id)).toEqual(["msg_done"])
})

test("a failed or interrupted session ends show and wait with the command that resumes it", async () => {
  const server = world()
  const failed = { ...assistant("e", "partial"), finish: "error", error: { message: "Model unavailable" } }
  server.state.messages = [user("q", "go"), failed]
  const resume = 'resume: turen-tui send ses_main --url "' + server.url + '" "<text>" --wait\n'
  for (const command of ["show", "wait"]) {
    const result = await agent([command, "ses_main", "--url", server.url], {})
    expect(result.stdout).toEndWith(resume)
    expect(result.stdout).toContain("failed")
  }
  server.state.messages = [user("q", "go"), assistant("a", "fine")]
  expect((await agent(["show", "ses_main"], { url: server.url })).stdout).not.toContain("resume:")
  expect((await agent(["wait", "ses_main"], { url: server.url })).stdout).not.toContain("resume:")
})

test("help works as a command word, and a capitalised command is a typo rather than a URL", async () => {
  const overview = await agent(["help"], {})
  expect(overview.code).toBe(0)
  expect(overview.stdout).toContain("Agent and script commands")
  const send = await agent(["help", "send"], {})
  expect(send.code).toBe(0)
  expect(send.stdout).toStartWith("Usage: turen-tui send")
  expect((await agent(["help", "nonsense"], {})).code).toBe(2)

  const typo = await agent(["Sessions"], {})
  expect(typo.code).toBe(2)
  expect(typo.stderr).toBe(
    'turen-tui: Unknown command "Sessions". Did you mean "sessions"? Run turen-tui --help for the list.\n',
  )
  expect(isCommandWord("Sessions")).toBe(true)
  expect(isCommandWord("SHOW")).toBe(true)
  // Host names and URLs still open the dashboard.
  for (const word of ["Localhost", "Example", "http://x", "Sessions.local", "Sessions:4096", "Sessions/x"])
    expect(isCommandWord(word)).toBe(false)
})

test("an ID of another kind is named, and a permission ID points at approve", async () => {
  const server = world()
  const result = await agent(["show", "per_123"], { url: server.url })
  expect(result.code).toBe(2)
  expect(result.stderr).toBe(
    "turen-tui: The session must be an ID starting with ses_ (per_ is a permission ID; use turen-tui approve).\n",
  )
  expect((await agent(["show", "que_1"], { url: server.url })).stderr).toContain("que_ is a question ID")
  expect((await agent(["show", "nonsense"], { url: server.url })).stderr).toBe(
    "turen-tui: The session must be an ID starting with ses_.\n",
  )
})
