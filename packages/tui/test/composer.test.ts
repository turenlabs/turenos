import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen, type Route } from "./support"

const running = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }
const stopped = { "POST /api/session/ses_main/interrupt": () => new Response(null, { status: 204 }) }
const prompt = {
  "POST /api/session/ses_main/prompt": async (request: Request) => {
    const body = (await request.json()) as { id: string }
    return { data: { id: body.id, sessionID: "ses_main" } }
  },
}
const permission = (
  requests: unknown[] = [{ id: "per_one", sessionID: "ses_main", action: "shell", resources: ["npm test"] }],
) => ({
  "POST /api/session/ses_main/permission/per_one/reply": () => new Response(null, { status: 204 }),
  "GET /api/session/ses_main/permission": () => ({ data: requests }),
})

/** A dashboard at `width` columns that records whether it quit, with the editor that has focus. */
async function open(routes: Record<string, Route>, width = 120) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, width < 90 ? 24 : 36, true)
  const quit = { called: false }
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, () => {
    quit.called = true
  })
  cleanup.push(app.dispose)
  await app.ready
  const editor = () => view.renderer.currentFocusedEditor
  return { server, view, screen, quit, editor }
}

test("opening a session puts typing into its reply editor, so letters are not dashboard shortcuts", async () => {
  const { server, view, screen, editor } = await open({})
  await screen("Focus: sidebar")
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("hello")
  await screen("hello")
  expect(editor()?.plainText).toBe("hello")
  // h, e and o would have opened History and Files and looked for a question.
  expect(view.captureCharFrame()).not.toContain("History ·")
  expect(view.captureCharFrame()).not.toContain("Files")
  expect(view.captureCharFrame()).not.toContain("No pending question")
  expect(server.paths().filter((path) => path.startsWith("/file"))).toEqual([])
})

test("a narrow terminal opens on the reply editor of the session it shows", async () => {
  const { view, screen, editor } = await open({}, 70)
  await screen("Esc shortcuts")
  await view.mockInput.typeText("hello")
  await screen("hello")
  expect(editor()?.plainText).toBe("hello")
})

test("the reply editor stays open and empty after sending, and keeps the sent notice", async () => {
  const { server, view, screen, editor } = await open(prompt)
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("first")
  view.mockInput.pressEnter()
  await screen("Reply sent.")
  await screen("Typing")
  expect(editor()?.plainText).toBe("")
  expect(server.sent("/api/session/ses_main/prompt")).toHaveLength(1)
  await view.mockInput.typeText("second")
  expect(editor()?.plainText).toBe("second")
})

test("Esc leaves the reply editor for shortcuts with its draft kept, and Enter returns to it", async () => {
  const { view, screen, editor } = await open({})
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("draft")
  view.mockInput.pressEscape()
  await screen("Focus: transcript")
  expect(view.captureCharFrame()).toContain("Draft kept")
  view.mockInput.pressKey("?")
  await screen("Keyboard shortcuts")
  view.mockInput.pressEscape()
  await screen("Focus: transcript")
  // Closing another dialog does not reopen the editor: shortcuts stay until Enter or f.
  expect(view.captureCharFrame()).not.toContain("Typing")
  view.mockInput.pressEnter()
  await screen("Typing")
  expect(editor()?.plainText).toBe("draft")
})

test("Ctrl+K opens the session picker straight from the reply editor and keeps the draft", async () => {
  const { view, screen, editor } = await open({})
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("half-written reply")
  view.mockInput.pressArrow("left")
  view.mockInput.pressKey("k", { ctrl: true })
  await screen("Switch session")
  // Closing the picker returns to the editor with its draft, as Ctrl+P does.
  view.mockInput.pressEscape()
  await screen("Typing")
  expect(editor()?.plainText).toBe("half-written reply")
})

test("Esc from the reply editor arms the stop, so Esc Esc stops a running turn while typing", async () => {
  const { server, view, screen } = await open({ ...running, ...stopped })
  view.mockInput.pressEnter()
  await screen("Esc Esc to stop")
  await screen("Typing")
  view.mockInput.pressEscape()
  await screen("Press Esc again to stop this turn")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
  view.mockInput.pressEscape()
  await screen("Session interrupted.")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(1)
})

test("the Esc-again prompt leaves the screen when its 2 s window closes, and a later Esc arms afresh", async () => {
  const { server, view, screen } = await open({ ...running, ...stopped })
  view.mockInput.pressEnter()
  await screen("Typing")
  view.mockInput.pressEscape()
  await screen("Press Esc again to stop this turn")
  const deadline = Date.now() + 3000
  while (view.captureCharFrame().includes("Press Esc again") && Date.now() < deadline) {
    await view.renderOnce()
    await Bun.sleep(50)
  }
  // The window is 2 s; the notice's own 5 s timer must not be what removes it.
  expect(Date.now()).toBeLessThan(deadline)
  expect(view.captureCharFrame()).not.toContain("Press Esc again")
  view.mockInput.pressEscape()
  await screen("Press Esc again to stop this turn and cancel its tasks")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
})

test("Ctrl+T says what the new delivery mode does", async () => {
  const { view, screen } = await open({ ...running, ...stopped })
  view.mockInput.pressEnter()
  await screen("Steer · agent is working")
  view.mockInput.pressKey("t", { ctrl: true })
  await screen("Queue: sent when the agent is idle")
  view.mockInput.pressKey("t", { ctrl: true })
  await screen("Steer: read at the next step")
})

test("with a permission waiting, an empty editor says Enter reviews it, and Enter does", async () => {
  const requests: unknown[] = []
  const { server, view, screen, editor } = await open({ ...running, ...stopped, ...permission(requests) })
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("half")
  requests.push({ id: "per_one", sessionID: "ses_main", action: "shell", resources: ["npm test"] })
  await screen("Permission waiting · Esc then Enter to answer")
  view.mockInput.pressKey("u", { ctrl: true })
  await screen("2 Allow once")
  view.mockInput.pressEscape()
  await screen("Enter reviews the permission · Esc Esc stops the turn")
  expect(editor()?.plainText).toBe("")
  view.mockInput.pressEnter()
  await screen("2 Allow once")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
})

test("a Ctrl+S right after a digit answers a permission is swallowed instead of erroring in the empty editor", async () => {
  const requests: unknown[] = []
  const { server, view, screen, editor } = await open(permission(requests))
  view.mockInput.pressEnter()
  await screen("Typing")
  requests.push({ id: "per_one", sessionID: "ses_main", action: "shell", resources: ["npm test"] })
  await screen("2 Allow once")
  await Bun.sleep(600)
  view.mockInput.pressKey("2")
  await screen("Allowed once.")
  requests.length = 0
  await screen("Typing")
  view.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(100)
  await view.renderOnce()
  expect(editor()).toBeDefined()
  expect(view.captureCharFrame()).not.toContain("Enter a message between")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")).toHaveLength(1)
})

test("Ctrl+C stops a running turn instead of quitting, and a second Ctrl+C quits", async () => {
  const { server, view, screen, quit } = await open({ ...running, ...stopped })
  await screen("x Stop")
  view.mockInput.pressKey("c", { ctrl: true })
  await screen("Session interrupted. Ctrl+C again quits.")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(1)
  expect(quit.called).toBe(false)
  view.mockInput.pressKey("c", { ctrl: true })
  expect(quit.called).toBe(true)
})

test("q warns while the selected session's turn runs instead of quitting at once", async () => {
  const { server, view, screen, quit } = await open(running)
  await screen("x Stop")
  view.mockInput.pressKey("q")
  await screen("The agent is still working")
  expect(quit.called).toBe(false)
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
  view.mockInput.pressKey("q")
  expect(quit.called).toBe(true)
})

test("q on a running session with a kept draft says the draft goes too before it quits", async () => {
  const { view, screen, quit } = await open(running)
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("unsent")
  view.mockInput.pressEscape()
  await screen("Focus: transcript")
  view.mockInput.pressKey("q")
  await screen("unsent drafts are discarded")
  expect(quit.called).toBe(false)
  view.mockInput.pressKey("q")
  expect(quit.called).toBe(true)
})

test("x stops a running turn at once without a typed confirmation, and says when nothing runs", async () => {
  const busy = await open({ ...running, ...stopped })
  await busy.screen("x Stop")
  busy.view.mockInput.pressKey("x")
  await busy.screen("Session interrupted.")
  expect(busy.server.sent("/api/session/ses_main/interrupt")).toHaveLength(1)
  expect(busy.view.captureCharFrame()).not.toContain("type stop")
  const idle = await open(stopped)
  await idle.screen("Enter type")
  idle.view.mockInput.pressKey("x")
  await idle.screen("Nothing is running in this session.")
  expect(idle.server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
})

test("a permission digit answers at once, but not in the first half second of a prompt that opened itself", async () => {
  const { server, view, screen } = await open(permission())
  await screen("2 Allow once")
  view.mockInput.pressKey("2")
  await screen("▶ 2 Allow once")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")).toHaveLength(0)
  await Bun.sleep(600)
  view.mockInput.pressKey("2")
  await screen("Allowed once.")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")[0]?.body).toMatchObject({ reply: "once" })
})

test("a permission opened with p answers on its digit straight away", async () => {
  const { server, view, screen } = await open(permission())
  await screen("2 Allow once")
  view.mockInput.pressEscape()
  await screen("p Review permission")
  view.mockInput.pressKey("p")
  await screen("2 Allow once")
  view.mockInput.pressKey("1")
  await screen("Permission rejected.")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")[0]?.body).toMatchObject({ reply: "reject" })
})

test("a new permission waits behind text being typed and takes the editor's place once it is empty", async () => {
  const requests: unknown[] = []
  const { view, screen, editor } = await open(permission(requests))
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("half")
  requests.push({ id: "per_one", sessionID: "ses_main", action: "shell", resources: ["npm test"] })
  await screen("Permission waiting · Esc then Enter to answer")
  expect(editor()?.plainText).toBe("half")
  view.mockInput.pressKey("u", { ctrl: true })
  await screen("2 Allow once")
})

test("while typing, the row under the editor keeps its status but no shortcut keys", async () => {
  const queued = {
    admittedSeq: 1,
    id: "msg_held",
    sessionID: "ses_main",
    prompt: { text: "held" },
    delivery: "queue",
    timeCreated: 1,
  }
  const { view, screen } = await open({ "GET /api/session/ses_main/input": () => ({ data: [queued] }) })
  await screen("u 1 queued")
  view.mockInput.pressEnter()
  await screen("Typing")
  await screen("1 queued")
  const frame = view.captureCharFrame()
  expect(frame).not.toContain("u 1 queued")
  expect(frame).not.toContain("h History")
  expect(frame).toContain("Esc shortcuts")
})
