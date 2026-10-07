import { expect, test } from "bun:test"
import { promptPayload } from "../src/prompt-files"
import { connect } from "../src/server"
import { cleanup, dashboard, session, turen, type Route } from "./support"

const invalid = (message: string) => () =>
  Response.json({ _tag: "InvalidRequestError", message }, { status: 400 })
const agents = (_: Request, url: URL) => ({
  location: { directory: url.searchParams.get("location[directory]") },
  data: [{ id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] }],
})
// Admission acknowledgements must echo the caller's message ID.
const accepted = async (request: Request) => ({ data: { id: (await request.json()).id, sessionID: "ses_main" } })

test("a shell command over the local limit leaves the reply editable and unlocked", async () => {
  const { server, view, screen } = await dashboard({
    "POST /api/session/ses_main/shell": async (request) => ({
      data: { id: (await request.json()).id, type: "shell", command: "ls", output: "", status: "running" },
    }),
  })
  view.mockInput.pressKey("f")
  await view.mockInput.typeText(`!${"x".repeat(8200)}`)
  view.mockInput.pressEnter()
  await screen("8,192")
  await view.mockInput.typeText("y")
  expect(view.renderer.currentFocusedEditor?.plainText.endsWith("xy")).toBe(true)
  view.renderer.currentFocusedEditor!.setText("!ls")
  view.mockInput.pressEnter()
  await screen("Shell command sent")
  expect(server.sent("/api/session/ses_main/shell")).toHaveLength(1)
})

test("a prompt the server rejects with a 4xx stays editable and resends under the same ID", async () => {
  let calls = 0
  const { server, view, screen } = await dashboard({
    "POST /api/session/ses_main/prompt": (request) => (++calls === 1 ? invalid("Prompt rejected for now")() : accepted(request)),
  })
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("first")
  view.mockInput.pressEnter()
  await screen("Prompt rejected for now")
  await view.mockInput.typeText(" more")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("first more")
  view.mockInput.pressEnter()
  await screen("Reply sent.")
  const [first, second] = server.sent("/api/session/ses_main/prompt")
  expect(second?.body).toMatchObject({ prompt: { text: "first more" } })
  expect((second?.body as { id: string }).id).toBe((first?.body as { id: string }).id)
})

test("a prompt that fails ambiguously still locks the reply to its original text", async () => {
  const { server, view, screen } = await dashboard({
    "POST /api/session/ses_main/prompt": () => new Response("lost", { status: 502 }),
  })
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("first")
  view.mockInput.pressEnter()
  await screen("HTTP 502")
  // The editor accepts keystrokes, but a send of changed text is refused before any request goes out.
  await view.mockInput.typeText(" more")
  view.mockInput.pressEnter()
  await screen("Retry the original message")
  expect(server.sent("/api/session/ses_main/prompt")).toHaveLength(1)
})

test("a lone surrogate in a mention is not attached and cannot fail the send", () => {
  expect(promptPayload("see @a\uD800b.ts now", "/srv/p")).toEqual({ text: "see @a\uD800b.ts now" })
})

test("shell requests wait for the server's command timeout and compaction waits longer", async () => {
  const { requestTimeout } = await import("../src/server/transport")
  const shell = new URL("http://127.0.0.1/api/session/ses_main/shell")
  const compact = new URL("http://127.0.0.1/api/session/ses_main/compact")
  expect(requestTimeout(shell, "POST")).toBeGreaterThan(120_000)
  expect(requestTimeout(compact, "POST")).toBeGreaterThan(120_000)
  expect(requestTimeout(new URL("http://127.0.0.1/api/session"), "GET")).toBe(10_000)
})

test("a failed command lookup sends nothing, so launch fields stay editable", async () => {
  const server = turen({
    routes: {
      "GET /api/command": () => new Response("down", { status: 500 }),
      // batou:ignore trust_boundary -- test fixture server echoing a synthetic session; no Express session exists here
      "POST /api/session": async (request) => ({ data: session(String((await request.json()).id).slice(4)) }),
      "POST /api/session/ses_main/prompt": accepted,
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  const launch = connection.launch()
  const input = { directory: "/srv/project", prompt: "/review the change" }
  await expect(launch(input)).rejects.toThrow()
  expect(launch.input()).toBeUndefined()
  await expect(launch({ ...input, prompt: "changed" })).rejects.not.toThrow("original fields")
})

test("a definite 4xx on create or prompt releases the launch fields and keeps the IDs", async () => {
  let creates = 0
  const posts: { path: string; body: unknown }[] = []
  const server = turen({
    routes: {
      "POST /api/session": async (request) => {
        const body = await request.json()
        posts.push({ path: "/api/session", body })
        // batou:ignore trust_boundary -- test fixture server echoing a synthetic session; no Express session exists here
        return ++creates === 1 ? invalid("Directory refused")() : { data: session(String(body.id).slice(4)) }
      },
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  const launch = connection.launch()
  const input = { directory: "/srv/project", prompt: "Review" }
  await expect(launch(input)).rejects.toBeDefined()
  expect(launch.input()).toBeUndefined()
  const sessionID = launch.sessionID
  const retry = { directory: "/srv/other", prompt: "Review again" }
  await expect(launch(retry)).rejects.toBeDefined()
  expect(posts.map((post) => (post.body as { id: string }).id)).toEqual([sessionID, sessionID])
  expect(posts[1]?.body).toMatchObject({ location: { directory: "/srv/other" } })
})

test("one deleted active session does not fail the snapshot", async () => {
  const server = turen({
    routes: {
      "GET /api/session/active": () => ({ data: { ses_gone: { type: "running" } } }),
      "GET /api/session/ses_gone": () =>
        Response.json({ _tag: "SessionNotFoundError", message: "gone", sessionID: "ses_gone" }, { status: 404 }),
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  const snapshot = await connection.snapshot()
  expect(snapshot.sessions.map((item) => item.id)).toEqual(["ses_main"])
})

test("kill reports task cancels that failed and ignores tasks that already finished", async () => {
  const task = (id: string, revision: number) => ({
    id,
    rootSessionID: "ses_main",
    parentSessionID: "ses_main",
    childSessionID: `ses_${id}`,
    agent: "explore",
    description: id,
    depth: 1,
    status: "running",
    revision,
    time: { created: 1, updated: 1 },
  })
  const { screen, palette, confirm } = await dashboard({
    "GET /api/session/ses_main/task": () => ({
      data: [],
      active: [task("tsk_a", 1), task("tsk_b", 2), task("tsk_c", 3)],
      cursor: { next: "older" },
    }),
    "POST /api/session/ses_main/interrupt": () => new Response(null, { status: 204 }),
    "POST /api/session/ses_main/task/tsk_a/cancel": () => new Response("boom", { status: 500 }),
    "POST /api/session/ses_main/task/tsk_b/cancel": () =>
      Response.json({ _tag: "TaskNotFoundError", message: "gone" }, { status: 404 }),
    "POST /api/session/ses_main/task/tsk_c/cancel": () => ({ data: task("tsk_c", 4) }),
  })
  await palette("kill")
  await screen("Type kill")
  await confirm("kill")
  await screen("1 cancelled, 1 failed, 1 not listed")
})

test("an escaping or malformed mention is flagged before send, and a malformed range is not attached", async () => {
  expect(promptPayload("@a.ts#5- and @b.ts#a-b", "/srv/p")).toEqual({ text: "@a.ts#5- and @b.ts#a-b" })
  const { server, view, screen } = await dashboard({
    "POST /api/session/ses_main/prompt": accepted,
  })
  view.mockInput.pressKey("f")
  // Text after the mention closes the file popup, which would otherwise swallow Enter while it loads.
  await view.mockInput.typeText("read @../../etc/passwd now")
  await screen("OUTSIDE /srv/main")
  view.mockInput.pressEnter()
  await screen("outside /srv/main")
  expect(server.sent("/api/session/ses_main/prompt")).toHaveLength(0)
  view.mockInput.pressEnter()
  await screen("Reply sent.")
  expect(server.sent("/api/session/ses_main/prompt")).toHaveLength(1)
})

test("the new-session editor does not advertise shell commands and refuses to send one to the model", async () => {
  const { server, view, screen } = await dashboard({
    "GET /api/agent": agents,
    "POST /api/session": () => new Response(null, { status: 500 }),
  })
  view.mockInput.pressKey("n")
  const frame = await screen("What would you like to do?")
  expect(frame).toContain("@ files")
  expect(frame).not.toContain("! shell")
  await view.mockInput.typeText("!rm -rf build")
  view.mockInput.pressEnter()
  await screen("Shell commands run in an existing session")
  expect(server.requests.filter((item) => item.method === "POST")).toHaveLength(0)
})

test("a cut at 32,000 characters never leaves half of a surrogate pair", async () => {
  const { view, screen } = await dashboard({})
  view.mockInput.pressKey("f")
  await screen("Type a message")
  view.renderer.currentFocusedEditor!.setText(`a${"😀".repeat(16000)}`)
  await screen("limited to 32,000")
  const text = view.renderer.currentFocusedEditor!.plainText
  expect(text.length).toBe(31999)
  expect(text.isWellFormed()).toBe(true)
})

test("a refused prompt after a created session keeps its ID and Ctrl+O visible", async () => {
  const created: string[] = []
  const base: Record<string, Route> = {
    "GET /api/agent": agents,
    "POST /api/session": async (request) => {
      const body = await request.json()
      created.push(body.id)
      // batou:ignore trust_boundary -- test fixture server echoing a synthetic session; no Express session exists here
      return { data: session(String(body.id).slice(4)) }
    },
  }
  const routes = new Proxy(base, {
    get(target, key) {
      if (typeof key !== "string") return undefined
      if (key === `GET /api/session/${created[0]}`) return () => ({ data: session(String(created[0]).slice(4)) })
      if (/^POST \/api\/session\/ses_[0-9a-f]+\/prompt$/.test(key)) return invalid("Prompt refused")
      return target[key]
    },
  })
  const { view, screen } = await dashboard(routes)
  view.mockInput.pressKey("n")
  await screen("What would you like to do?")
  await view.mockInput.typeText("Review")
  view.mockInput.pressEnter()
  const frame = await screen("Prompt refused")
  expect(frame).toContain(`Session: ${created[0]}`)
  expect(frame).toContain("Ctrl+O inspect")
})
