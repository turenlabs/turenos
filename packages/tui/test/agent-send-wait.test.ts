import { expect, test } from "bun:test"
import { agent, document, permission, refusal, task, user, world } from "./agent-fixture"

const reply = (id: string, text: string) => ({
  id: `msg_${id}`,
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "model" },
  time: { created: 2, completed: 3 },
  finish: "stop",
  content: [{ id: `text_${id}`, type: "text", text }],
})

test("send --wait waits for the reply even when the first active read comes before the turn is marked busy", async () => {
  const turns = { count: 0 }
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      const turn = ++turns.count
      server.state.prompts.push(body)
      server.state.messages.push({ id: body.id, type: "user", time: { created: 1 }, text: body.prompt.text })
      // The server marks the session busy a moment after admitting, and replies a moment after that.
      setTimeout(() => server.state.active.add("ses_main"), 300)
      setTimeout(() => {
        server.state.messages.push(reply(`turn${turn}`, `answer ${turn}`))
        server.state.active.delete("ses_main")
      }, 900)
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const begin = Date.now()
  const result = await agent(["send", "ses_main", "question", "--wait"], { url: server.url })
  expect(result.code).toBe(0)
  expect(Date.now() - begin).toBeGreaterThanOrEqual(850)
  expect(result.stdout).toStartWith("session ses_main · idle\n")
  expect(result.stdout).toContain("answer 1")
  // Only what came after the sent message, not the reply that was already there.
  expect(result.stdout).not.toContain("hello")

  const json = document(await agent(["send", "ses_main", "again", "--wait", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "idle" })
  expect((json.messages as { id: string }[]).map((message) => message.id)).toEqual(["msg_turn2"])
})

test("send --wait exits 3 with the follow-up commands when a permission appears, and 4 on timeout", async () => {
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string }
      server.state.prompts.push(body)
      server.state.active.add("ses_main")
      setTimeout(() => server.state.permissions.push(permission("per_7")), 200)
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const waiting = await agent(["send", "ses_main", "run it", "--wait"], { url: server.url })
  expect(waiting.code).toBe(3)
  expect(waiting.stdout).toContain("session ses_main · needs-input")
  expect(waiting.stdout).toContain("  approve: turen-tui approve ses_main per_7")
  expect(waiting.stdout).toContain("  reject:  turen-tui reject ses_main per_7")
  const json = document(await agent(["wait", "ses_main", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "needs-input" })

  server.state.permissions.length = 0
  server.state.active.add("ses_main")
  const timeout = await agent(["wait", "ses_main", "--timeout", "1"], { url: server.url })
  expect(timeout.code).toBe(4)
  expect(timeout.stdout).toContain("session ses_main · timeout")
  expect(document(await agent(["wait", "ses_main", "--timeout", "1", "--json"], { url: server.url }))).toMatchObject({
    state: "timeout",
  })
})

test("wait on an idle session prints its last reply", async () => {
  const server = world()
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("session ses_main · idle")
  expect(result.stdout).toContain("hello")
})

const failed = (id: string, message: string) => ({ ...reply(id, "partial"), finish: "error", error: { message } })

const providerFailure =
  'Provider request failed with HTTP 401: {"error":{"message":"invalid x-api-key","type":"authentication_error"}}'

test("wait exits 5 when the idle session's latest turn failed, and a recovered or successful turn exits 0", async () => {
  const server = world()
  server.state.messages.push(user("q", "go"), failed("f", providerFailure))
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout).toStartWith("session ses_main · failed\n    HTTP 401: invalid x-api-key\n")
  const json = document(await agent(["wait", "ses_main", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "failed", message: { id: "msg_f" } })

  server.state.messages.push(user("r", "again"), reply("ok", "fine"))
  const recovered = await agent(["wait", "ses_main"], { url: server.url })
  expect(recovered.code).toBe(0)
  expect(recovered.stdout).toStartWith("session ses_main · idle\n")
  expect(document(await agent(["wait", "ses_main", "--json"], { url: server.url }))).toMatchObject({ state: "idle" })
})

test("wait exits 5 and says interrupted when the turn was stopped", async () => {
  const server = world()
  server.state.messages.push(user("q", "go"), failed("i", "Provider turn interrupted"))
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout).toStartWith("session ses_main · interrupted\n    The turn was stopped before it finished.\n")
  expect(document(await agent(["wait", "ses_main", "--json"], { url: server.url }))).toMatchObject({
    state: "interrupted",
  })
})

test("send --wait exits 5 when the reply to the sent message is a failed turn", async () => {
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      server.state.prompts.push(body)
      server.state.messages.push(
        user(body.id.slice(4), body.prompt.text),
        failed(`late${server.state.prompts.length}`, providerFailure),
      )
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const result = await agent(["send", "ses_main", "go", "--wait"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout).toStartWith("session ses_main · failed\n    HTTP 401: invalid x-api-key\n")
  const json = document(await agent(["send", "ses_main", "go again", "--wait", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "failed" })
})

test("send --wait that fails after the message landed names the sent message and how to resume", async () => {
  const failNext = { messages: false }
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string }
      server.state.prompts.push(body)
      failNext.messages = true
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
    "GET /api/session/ses_main/message": () => {
      if (!failNext.messages) return { data: server.state.messages.toReversed(), cursor: {} }
      failNext.messages = false
      return refusal()
    },
  })
  const result = await agent(["send", "ses_main", "go", "--wait", "--json"], { url: server.url })
  expect(result.code).toBe(1)
  const error = document(result).error as { message: string; messageID: string; state: string }
  expect(error.state).toBe("sent")
  expect(error.messageID).toMatch(/^msg_[0-9a-f]{32}$/)
  expect(error.message).toContain(`Message ${error.messageID} was sent to session ses_main`)
  expect(error.message).toContain("turen-tui wait ses_main")
  expect(error).not.toHaveProperty("retry")
})

test("wait polls through a transient failure, and reports a session deleted meanwhile", async () => {
  const failures = { active: 1 }
  const server = world({
    "GET /api/session/active": () => {
      if (failures.active-- > 0) return new Response("restarting", { status: 503 })
      return { data: {} }
    },
  })
  const begin = Date.now()
  const result = await agent(["wait", "ses_main", "--timeout", "10"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("session ses_main · idle")
  // A failed pass waits about two seconds before the next one instead of ending the wait.
  expect(Date.now() - begin).toBeGreaterThanOrEqual(1500)

  const gone = world({
    "GET /api/session/ses_main/message": () =>
      Response.json({ _tag: "SessionNotFoundError", message: "gone" }, { status: 404 }),
  })
  const deleted = await agent(["wait", "ses_main"], { url: gone.url })
  expect(deleted.code).toBe(1)
  expect(deleted.stderr).toContain("deleted while waiting")
})

test("wait ends with the input a running session's subagent is waiting for", async () => {
  const server = world({
    "GET /api/session/ses_main/task": () => ({
      data: [],
      active: [task("tsk_child", { childSessionID: "ses_child" })],
      cursor: {},
    }),
    "GET /api/session/ses_child/permission": () => ({
      data: [permission("per_child", { sessionID: "ses_child" })],
    }),
    "GET /api/session/ses_child/question": () => ({ data: [] }),
  })
  server.state.active.add("ses_main")
  const result = await agent(["wait", "ses_main", "--timeout", "5"], { url: server.url })
  expect(result.code).toBe(3)
  expect(result.stdout).toContain("session ses_main · needs-input")
  expect(result.stdout).toContain("  approve: turen-tui approve ses_child per_child")
  const json = document(await agent(["wait", "ses_main", "--timeout", "5", "--json"], { url: server.url }))
  expect((json.pending as { permissions: { sessionID: string }[] }).permissions[0]!.sessionID).toBe("ses_child")
})

test("send --queue --wait does not take the running turn's reply while the message is still queued", async () => {
  const queue: string[] = []
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      server.state.prompts.push(body)
      queue.push(body.id)
      // The running turn ends first; the queued message is read and answered after it.
      setTimeout(() => {
        server.state.messages.push(reply("first", "answer A"))
        server.state.active.delete("ses_main")
      }, 200)
      setTimeout(() => {
        queue.length = 0
        server.state.messages.push(user(body.id.slice(4), body.prompt.text))
        server.state.active.add("ses_main")
      }, 700)
      setTimeout(() => {
        server.state.messages.push(reply("second", "answer B"))
        server.state.active.delete("ses_main")
      }, 1000)
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
    "GET /api/session/ses_main/input": () => ({
      data: queue.map((id) => ({ id, sessionID: "ses_main", admittedSeq: 1, prompt: { text: "later" } })),
    }),
  })
  server.state.active.add("ses_main")
  const result = await agent(["send", "ses_main", "later", "--queue", "--wait"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("answer B")
  expect(result.stdout).not.toContain("answer A")
})
