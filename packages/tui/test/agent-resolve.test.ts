import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { agent, document, permission, question, task, world } from "./agent-fixture"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const noContent = () => new Response(null, { status: 204 })

function resolving() {
  const posts: { path: string; body: unknown }[] = []
  const record = (path: string) => async (request: Request) => {
    posts.push({ path, body: await request.text().then((text) => (text ? JSON.parse(text) : undefined)) })
    return noContent()
  }
  const server = world({
    "POST /api/session/ses_main/permission/per_1/reply": record("per_1/reply"),
    "POST /api/session/ses_main/question/que_1/reply": record("que_1/reply"),
    "POST /api/session/ses_main/question/que_1/reject": record("que_1/reject"),
    "POST /api/session/ses_main/interrupt": record("interrupt"),
  })
  return { server, posts }
}

test("approve and reject reply to the permission, and --always needs a rule to save", async () => {
  const { server, posts } = resolving()
  server.state.permissions.push(permission("per_1"))
  expect((await agent(["approve", "ses_main", "per_1"], { url: server.url })).stdout).toBe("approved per_1 (once)\n")
  const always = await agent(["approve", "ses_main", "per_1", "--always"], { url: server.url })
  expect(always.code).toBe(2)
  expect(always.stderr).toContain("offers no rule to save")
  expect(posts).toEqual([{ path: "per_1/reply", body: { reply: "once" } }])

  server.state.permissions[0] = permission("per_1", { save: ["echo *"] })
  expect(document(await agent(["approve", "ses_main", "per_1", "--always", "--json"], { url: server.url }))).toEqual({
    ok: true,
    session: "ses_main",
    permission: "per_1",
    reply: "always",
  })
  expect((await agent(["reject", "ses_main", "per_1"], { url: server.url })).stdout).toBe("rejected per_1\n")
  expect(posts.map((post) => post.body)).toEqual([{ reply: "once" }, { reply: "always" }, { reply: "reject" }])

  const gone = await agent(["approve", "ses_main", "per_404"], { url: server.url })
  expect(gone.code).toBe(1)
  expect(gone.stderr).toContain("Permission per_404 is not pending for session ses_main")
})

test("answer checks every label against the options and lists the valid ones", async () => {
  const { server, posts } = resolving()
  server.state.questions.push(question())
  const unknown = await agent(["answer", "ses_main", "que_1", "--choice", "Green"], { url: server.url })
  expect(unknown.code).toBe(2)
  expect(unknown.stderr).toContain('"Green" is not an option for question 1. Valid choices: Red | Blue.')
  const many = await agent(["answer", "ses_main", "que_1", "--choice", "Red", "--choice", "Blue"], { url: server.url })
  expect(many.code).toBe(2)
  expect(many.stderr).toContain("takes one answer")
  expect((await agent(["answer", "ses_main", "que_1"], { url: server.url })).code).toBe(2)
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "Red", "--reject"], { url: server.url })).code).toBe(
    2,
  )
  expect(posts).toEqual([])

  const ok = await agent(["answer", "ses_main", "que_1", "--choice", "Blue", "--json"], { url: server.url })
  expect(document(ok)).toMatchObject({ ok: true, question: "que_1", answers: [["Blue"]] })
  expect(posts).toEqual([{ path: "que_1/reply", body: { answers: [["Blue"]] } }])
})

test("answer accepts custom text where allowed, several choices where multiple, and --answers for many questions", async () => {
  const { server, posts } = resolving()
  const open = { header: "Name", question: "Name it", options: [{ label: "Alpha", description: "first" }] }
  const several = {
    ...open,
    header: "Tags",
    multiple: true,
    options: [
      { label: "x", description: "" },
      { label: "y", description: "" },
    ],
  }
  server.state.questions.push(question("que_1", { questions: [open, several] }))
  const single = await agent(["answer", "ses_main", "que_1", "--choice", "Alpha"], { url: server.url })
  expect(single.code).toBe(2)
  expect(single.stderr).toContain("2 questions. Use --answers")
  const bad = await agent(["answer", "ses_main", "que_1", "--answers", '[["Alpha"]]'], { url: server.url })
  expect(bad.code).toBe(2)
  expect((await agent(["answer", "ses_main", "que_1", "--answers", "not json"], { url: server.url })).code).toBe(2)
  expect(posts).toEqual([])

  const done = await agent(["answer", "ses_main", "que_1", "--answers", '[["My own name"],["x","y"]]'], {
    url: server.url,
  })
  expect(done.code).toBe(0)
  expect(posts).toEqual([{ path: "que_1/reply", body: { answers: [["My own name"], ["x", "y"]] } }])

  const text = await agent(["pending", "ses_main"], { url: server.url })
  expect(text.stdout).toContain("question que_1 · session ses_main · 2 questions")
  expect(text.stdout).toContain(`turen-tui answer ses_main que_1 --answers='[["Alpha"],["x"]]'`)

  const rejected = await agent(["answer", "ses_main", "que_1", "--reject"], { url: server.url })
  expect(rejected.stdout).toBe("rejected que_1\n")
  expect(posts.at(-1)).toEqual({ path: "que_1/reject", body: undefined })
})

test("stop interrupts, and --tasks reports cancelled, failed and not-listed tasks as the dashboard does", async () => {
  const { server, posts } = resolving()
  server.state.active.add("ses_main")
  expect((await agent(["stop", "ses_main"], { url: server.url })).stdout).toBe("interrupted ses_main\n")
  const tasks = (failing: boolean) => ({
    "GET /api/session/ses_main/task": () => ({
      data: [],
      active: [task("tsk_a"), task("tsk_b", { revision: 2 }), task("tsk_c", { revision: 3 })],
      cursor: { next: "older" },
    }),
    "POST /api/session/ses_main/task/tsk_a/cancel": () =>
      failing ? new Response("boom", { status: 500 }) : { data: task("tsk_a", { revision: 2 }) },
    "POST /api/session/ses_main/task/tsk_b/cancel": () =>
      Response.json({ _tag: "TaskNotFoundError", message: "gone" }, { status: 404 }),
    "POST /api/session/ses_main/task/tsk_c/cancel": () => ({ data: task("tsk_c", { revision: 4 }) }),
    "POST /api/session/ses_main/interrupt": noContent,
  })
  const calm = world(tasks(false))
  calm.state.active.add("ses_main")
  const done = await agent(["stop", "ses_main", "--tasks", "--json"], { url: calm.url })
  expect(done.code).toBe(0)
  expect(document(done)).toEqual({
    ok: true,
    session: "ses_main",
    running: true,
    tasks: { cancelled: 2, failed: 0, gone: 1, more: true },
  })
  const broken = world(tasks(true))
  broken.state.active.add("ses_main")
  const failing = await agent(["stop", "ses_main", "--tasks"], { url: broken.url })
  expect(failing.code).toBe(1)
  expect(failing.stderr).toContain("tasks: 1 cancelled, 1 failed, 1 not listed")
  expect(posts.map((post) => post.path)).toEqual(["interrupt"])
})

test("stop on a session that is not running says so and does not interrupt it, and --tasks still applies", async () => {
  const { server, posts } = resolving()
  const idle = await agent(["stop", "ses_main"], { url: server.url })
  expect(idle.code).toBe(0)
  expect(idle.stdout).toBe("ses_main was not running\n")
  expect(document(await agent(["stop", "ses_main", "--json"], { url: server.url }))).toEqual({
    ok: true,
    session: "ses_main",
    running: false,
  })
  expect(posts).toEqual([])

  const withTasks = world({
    "GET /api/session/ses_main/task": () => ({ data: [], active: [task("tsk_a")], cursor: {} }),
    "POST /api/session/ses_main/task/tsk_a/cancel": () => ({ data: task("tsk_a", { revision: 2 }) }),
  })
  const result = await agent(["stop", "ses_main", "--tasks"], { url: withTasks.url })
  expect(result.stdout).toBe("ses_main was not running; tasks: 1 cancelled, 0 failed, 0 not listed.\n")
})

test("an explicit URL that needs a password says which variable holds it, and never falls back to discovery", async () => {
  const server = world({}, "test-only-password")
  const missing = await agent(["sessions"], { url: server.url })
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain("requires a password. Set FORGE_SERVER_PASSWORD")
  expect(missing.stderr).not.toContain("test-only-password")
  expect(document(await agent(["sessions", "--json"], { url: server.url })).error).toMatchObject({
    message: expect.stringContaining("FORGE_SERVER_PASSWORD"),
  })
  const authed = await agent(["sessions", "--json"], {
    url: server.url,
    env: { FORGE_SERVER_PASSWORD: "test-only-password" },
  })
  expect(authed.code).toBe(0)
  const wrong = await agent(["sessions"], { url: server.url, env: { FORGE_SERVER_PASSWORD: "wrong" } })
  expect(wrong.code).toBe(1)
  expect(wrong.stderr).toContain("Check the server credentials")

  // An unreachable explicit URL is an error, never another server; --server wins over the environment.
  const quiet = world()
  const down = await agent(["sessions", "--url", "http://127.0.0.1:1"], { url: quiet.url })
  expect(down.code).toBe(1)
  const named = await agent(["sessions", "--server", "nosuch"], { url: quiet.url })
  expect(named.stderr).toBe("turen-tui: No saved server named nosuch.\n")
  expect(quiet.requests).toEqual([])
  expect((await agent(["sessions", "--url", "https://user:secret@example.com"])).stderr).not.toContain("secret")
})

test("the bin runs an agent command without a terminal and leaves the dashboard path alone", async () => {
  const server = world()
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      env: { PATH: "", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  }
  const listed = await run(["sessions", "--json"], { TURENOS_SERVER_URL: server.url })
  expect(listed.exitCode).toBe(0)
  expect(JSON.parse(listed.stdout).sessions[0].id).toBe("ses_main")
  const failed = await run(["show", "ses_main", "--limit", "0"])
  expect(failed.exitCode).toBe(2)

  for (const args of [[], [server.url]]) {
    const dashboard = await run(args)
    expect(dashboard.exitCode).toBe(1)
    expect(dashboard.stdout).toBe("")
    expect(dashboard.stderr).toBe(
      "turen-tui: The dashboard needs an interactive terminal. For scripts and agents, use the commands in turen-tui --help (e.g. turen-tui sessions --json).\n",
    )
  }
  const help = await run(["--help"])
  expect(help.stdout).toContain("Agent and script commands")
  expect(help.stdout).toContain("turen-tui send --new")
})

test("answer prefers an exact label, refuses a blank one, and says when it sends custom text", async () => {
  const { server, posts } = resolving()
  server.state.questions.push(
    question("que_1", {
      questions: [
        {
          header: "Pick",
          question: "Which?",
          options: [
            { label: "a  b", description: "two spaces" },
            { label: "a b", description: "one space" },
          ],
          custom: true,
        },
      ],
    }),
  )
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "a b"], { url: server.url })).code).toBe(0)
  expect(posts.at(-1)).toEqual({ path: "que_1/reply", body: { answers: [["a b"]] } })
  expect((await agent(["answer", "ses_main", "que_1", "--choice", "   "], { url: server.url })).code).toBe(2)
  const custom = await agent(["answer", "ses_main", "que_1", "--choice=-1"], { url: server.url })
  expect(custom.code).toBe(0)
  expect(custom.stderr).toContain("sent as a custom answer")
  expect(posts.at(-1)).toEqual({ path: "que_1/reply", body: { answers: [["-1"]] } })
})
