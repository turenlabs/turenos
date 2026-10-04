import { expect, test } from "bun:test"
import { dashboard, session } from "./support"

const pageDown = "\u001B[6~"

/** Renders until `text` has left the screen. */
async function gone(view: { renderOnce: () => Promise<void>; captureCharFrame: () => string }, text: string) {
  for (let attempt = 0; attempt < 100 && view.captureCharFrame().includes(text); attempt++) {
    await view.renderOnce()
    await Bun.sleep(10)
  }
  expect(view.captureCharFrame()).not.toContain(text)
}

const interrupt = { "POST /api/session/ses_main/interrupt": () => new Response(null, { status: 204 }) }

test("the stop panel names its verb, keeps it after a wrong word and clears the error once the text changes", async () => {
  const { server, view, screen, confirm } = await dashboard(interrupt)
  await screen("main task")
  view.mockInput.pressKey("x")
  const panel = await screen("Stop session")
  expect(panel).toContain("Ctrl+S stop")
  expect(panel).not.toContain("Ctrl+S Send")
  await confirm("sto")
  const failed = await screen("Type stop to confirm.")
  expect(failed).toContain("Ctrl+S stop")
  expect(failed).not.toContain("Ctrl+S retry")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(0)
  await view.mockInput.typeText("p")
  await view.renderOnce()
  const corrected = view.captureCharFrame()
  expect(corrected).not.toContain("Type stop to confirm.")
  expect(corrected).toContain("Ctrl+S stop")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Session interrupted.")
  expect(server.sent("/api/session/ses_main/interrupt")).toHaveLength(1)
})

test("typed-word dialogs label the field and say Esc closes to the dashboard", async () => {
  const { view, screen, palette } = await dashboard({})
  await screen("main task")
  for (const [name, word] of [
    ["Archive / restore session", "archive"],
    ["Delete session", "delete"],
    ["Stop all agents", "stop all"],
  ] as const) {
    await palette(name)
    const frame = await screen(`type ${word}`)
    expect(frame).toContain("Confirmation")
    expect(frame).toContain("Esc close")
    expect(frame).not.toContain("Esc cancel")
    view.mockInput.pressEscape()
    await gone(view, `type ${word}`)
  }
})

test("archiving a session says which session the dashboard now shows", async () => {
  let archived = false
  const { server, screen, palette, confirm } = await dashboard({
    "GET /api/session": () => ({
      data: archived ? [session("other")] : [session("main"), session("other")],
      cursor: {},
    }),
    "GET /api/session/ses_other": () => ({ data: session("other") }),
    "GET /api/session/ses_other/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_other/task": () => ({ data: [], active: [], cursor: {} }),
    "GET /api/session/ses_other/permission": () => ({ data: [] }),
    "GET /api/session/ses_other/question": () => ({ data: [] }),
    "GET /api/session/ses_other/input": () => ({ data: [] }),
    "PATCH /session/ses_main": async (request) => {
      archived = true
      const body = (await request.json()) as { time: { archived: number } }
      return {
        id: "ses_main",
        title: "main task",
        directory: "/srv/main",
        time: { created: 1, updated: 3, ...body.time },
      }
    },
  })
  await screen("main task")
  await palette("Archive / restore session")
  await confirm("archive")
  await screen("Now showing other task")
  expect(server.sent("/session/ses_main")).toHaveLength(1)
})

test("Ctrl+C in a dialog without a draft says it closed", async () => {
  const { view, screen, palette } = await dashboard({})
  await screen("main task")
  await palette("Delete session")
  await screen("type delete")
  view.mockInput.pressCtrlC()
  await screen("Closed.")
  await gone(view, "type delete")
})

test("the command palette keeps its search field when paging, and lists the parent entry only for a child", async () => {
  const { view, screen } = await dashboard({})
  await screen("main task")
  view.mockInput.pressKey("p", { ctrl: true })
  await screen("Find a command")
  view.mockInput.pressKey(pageDown)
  const paged = await screen("25/")
  expect(paged).toContain("Find a command")
  expect(paged).not.toContain("Go to parent session")
})

test("a child session's palette offers its parent", async () => {
  const child = { ...session("main"), parentID: "ses_root" }
  const { view, screen } = await dashboard({
    "GET /api/session": () => ({ data: [child], cursor: {} }),
    "GET /api/session/ses_main": () => ({ data: child }),
  })
  await screen("main task")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("parent")
  await screen("Go to parent session")
})

test("Open by ID returns to the finder with its search kept", async () => {
  const { view, screen } = await dashboard({})
  await screen("main task")
  view.mockInput.pressKey("k", { ctrl: true })
  await screen("Switch session")
  await view.mockInput.typeText("zzz")
  view.mockInput.pressKey("o", { ctrl: true })
  const dialog = await screen("Open session by ID")
  expect(dialog).toContain("Esc back")
  view.mockInput.pressEscape()
  const finder = await screen("Switch session")
  expect(finder).toContain("zzz")
  expect(finder).not.toContain("Open session by ID")
})

test("Open by ID from the palette closes instead", async () => {
  const { view, screen, palette } = await dashboard({})
  await screen("main task")
  await palette("Open session by ID")
  expect(await screen("Open session by ID")).toContain("Esc close")
  view.mockInput.pressEscape()
  await gone(view, "Open session by ID")
})
