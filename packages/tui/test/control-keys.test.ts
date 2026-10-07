import { expect, test } from "bun:test"
import { dashboard } from "./support"

const running = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }
const permission = (save?: string[]) => ({
  "POST /api/session/ses_main/permission/per_one/reply": () => new Response(null, { status: 204 }),
  "GET /api/session/ses_main/permission": () => ({
    data: [{ id: "per_one", sessionID: "ses_main", action: "shell", resources: ["npm test"], save }],
  }),
})
const queued = (id: string) => ({
  admittedSeq: 1,
  id,
  sessionID: "ses_main",
  prompt: { text: id },
  delivery: "queue",
  timeCreated: 1,
})

test("a pending permission opens by itself, shows its digits and keeps Allow always on screen at 60x24", async () => {
  const { server, view, screen } = await dashboard(permission(["npm *"]))
  view.resize(60, 24)
  await screen("3 Allow always")
  // A digit within half a second of a prompt that opened itself only moves the selection.
  view.mockInput.pressKey("3")
  await screen("▶ 3 Allow always")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")).toHaveLength(0)
  view.mockInput.pressArrow("up")
  await screen("▶ 2 Allow once")
  view.mockInput.pressArrow("down")
  await screen("▶ 3 Allow always")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")).toHaveLength(0)
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Allowed always.")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")[0]?.body).toMatchObject({ reply: "always" })
})

test("a permission digit only selects right after the prompt opens itself, then answers once half a second has passed", async () => {
  const { server, view, screen } = await dashboard(permission(["npm *"]))
  await screen("3 Allow always")
  view.mockInput.pressKey("3")
  await screen("▶ 3 Allow always")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")).toHaveLength(0)
  await Bun.sleep(600)
  view.mockInput.pressKey("3")
  await screen("Allowed always.")
  expect(server.sent("/api/session/ses_main/permission/per_one/reply")[0]?.body).toMatchObject({ reply: "always" })
})

test("Esc twice within two seconds stops a running turn; one Esc only warns", async () => {
  const { server, view, screen } = await dashboard({
    ...running,
    "POST /api/session/ses_main/interrupt": () => new Response(null, { status: 204 }),
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_held")] }),
  })
  await screen("u 1 queued")
  view.mockInput.pressEscape()
  await screen("Press Esc again to stop this turn")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
  view.mockInput.pressEscape()
  await screen("Stopped. 1 queued message is held: u to send or discard")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(1)
})

test("Esc Esc on an idle session opens the undo dialog; one Esc only warns and sends nothing", async () => {
  const { server, view, screen } = await dashboard({})
  await screen("f Reply")
  view.mockInput.pressEscape()
  await screen("Press Esc again to rewind")
  expect(view.captureCharFrame()).not.toContain("Undo conversation?")
  view.mockInput.pressEscape()
  await screen("Undo conversation?")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
  expect(server.sent("/api/session/ses_main/revert/stage")).toHaveLength(0)
})

test("Esc Esc on an idle session with no messages says there is nothing to undo", async () => {
  const { view, screen } = await dashboard({ "GET /api/session/ses_main/message": () => ({ data: [], cursor: {} }) })
  await screen("f Reply")
  view.mockInput.pressEscape()
  await screen("Nothing to undo in this session.")
  expect(view.captureCharFrame()).not.toContain("Undo conversation?")
})

test("Ctrl+G opens the reply draft in $EDITOR like F2", async () => {
  const saved = process.env.VISUAL
  const editor = process.env.EDITOR
  delete process.env.VISUAL
  delete process.env.EDITOR
  try {
    const { view, screen } = await dashboard({})
    view.mockInput.pressKey("f")
    await screen("Send · Reply to")
    view.mockInput.pressKey("g", { ctrl: true })
    await screen("$EDITOR")
  } finally {
    if (saved !== undefined) process.env.VISUAL = saved
    if (editor !== undefined) process.env.EDITOR = editor
  }
})

test("the reply editor says Send while idle and remembers Queue per session while running", async () => {
  const idle = await dashboard({})
  idle.view.mockInput.pressKey("f")
  await idle.screen("Send · Reply to")
  expect(idle.view.captureCharFrame()).not.toContain("Ctrl+T mode")
  const busy = await dashboard(running)
  busy.view.mockInput.pressKey("f")
  await busy.screen("Steer · Reply to")
  busy.view.mockInput.pressKey("t", { ctrl: true })
  await busy.screen("Queue · Reply to")
  busy.view.mockInput.pressEscape()
  busy.view.mockInput.pressKey("f")
  await busy.screen("Queue · Reply to")
})

test("a held queued message is described as held while the session is idle", async () => {
  const { view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_held")] }),
  })
  view.mockInput.pressKey("u")
  await screen("Held · agent is idle")
})
