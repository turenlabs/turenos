import { expect, test } from "bun:test"
import { dashboard, session } from "./support"

const message = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } })
const staged = {
  messageID: "msg_a",
  snapshot: "tree_original",
  diff: "patch",
  files: [{ path: "file.txt", status: "modified", additions: 1, deletions: 0, patch: "patch" }],
}

const inventory = {
  "GET /api/command": () => ({
    location: { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } },
    data: [],
  }),
}

async function gone(view: { renderOnce: () => Promise<void>; captureCharFrame: () => string }, text: string) {
  for (let attempt = 0; attempt < 100 && view.captureCharFrame().includes(text); attempt++) {
    await view.renderOnce()
    await Bun.sleep(10)
  }
  expect(view.captureCharFrame()).not.toContain(text)
}

test("the archived tab names itself in the title and explains an empty list", async () => {
  const { view, screen } = await dashboard({
    "GET /api/session": (_, url) => ({ data: url.search.includes("archived=true") ? [] : [session()], cursor: {} }),
  })
  await screen("main task")
  view.mockInput.pressKey("k", { ctrl: true })
  await screen("Switch session")
  view.mockInput.pressKey("F2")
  view.mockInput.pressKey("F2")
  const frame = await screen("No archived sessions")
  expect(frame).toContain("Switch session › Archived")
  expect(frame).not.toContain("No matching titles")
})

test("every finder tab lists the same navigation hints", async () => {
  const { view, screen } = await dashboard({})
  await screen("main task")
  view.mockInput.pressKey("k", { ctrl: true })
  const recent = await screen("Ctrl+O ID")
  expect(recent).toContain("Esc close")
  view.mockInput.pressKey("F2")
  await screen("Switch session › All sessions")
  const all = await screen("Enter open")
  for (const hint of ["Enter open", "F2 Archived", "Ctrl+O ID", "Esc close"]) expect(all).toContain(hint)
})

test("Esc in History returns to the live transcript without arming a rewind", async () => {
  const { view, screen } = await dashboard({})
  await screen("main task")
  view.mockInput.pressKey("h")
  await screen("History ·")
  view.mockInput.pressEscape()
  const live = await screen("Transcript ·")
  expect(live).not.toContain("Press Esc again to rewind")
  expect(live).not.toContain("History ·")
})

test("running /history leaves no draft behind and does not claim one", async () => {
  const { view, screen } = await dashboard(inventory)
  await screen("main task")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/history")
  await screen("▶ ")
  view.mockInput.pressEnter()
  await screen("History ·")
  expect(view.captureCharFrame()).not.toContain("Message draft kept")
})

test("an in-progress to-do does not reuse the selection marker, and the Tasks title names its session", async () => {
  const { view, screen } = await dashboard({
    "GET /session/ses_main/todo": () => [
      { content: "Read the parser", status: "completed", priority: "high" },
      { content: "Fix the off-by-one", status: "in_progress", priority: "high" },
    ],
  })
  await screen("t Tasks")
  view.mockInput.pressKey("t")
  const frame = await screen("TO-DOS")
  expect(frame).toContain("main task › Tasks")
  expect(frame).toContain("◐ Fix the off-by-one")
  expect(frame).not.toContain("▶ Fix the off-by-one")
  expect(frame).toContain("read-only")
})

test("the slash list marks its selection like every other list", async () => {
  const { view, screen } = await dashboard(inventory)
  await screen("main task")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/hel")
  const frame = await screen("help")
  expect(frame).toMatch(/▶ \/?help/)
  expect(frame).not.toMatch(/^\s*│?\s*> \/?help/m)
})

test("Details shows the agent the session actually runs with", async () => {
  const bare = { ...session(), agent: undefined }
  const { view, screen } = await dashboard({
    "GET /api/session": () => ({ data: [bare], cursor: {} }),
    "GET /api/session/ses_main": () => ({ data: bare }),
  })
  await screen("main task")
  view.mockInput.pressKey("i")
  const frame = await screen("Session ID")
  expect(frame).toContain("Agent: build")
  expect(frame).not.toContain("Agent: server default")
})

test("undo labels its typed word and file mode, and a wrong word keeps the verb in the footer", async () => {
  const { view, screen, palette, confirm } = await dashboard({
    "GET /api/session/ses_main/message": () => ({ data: [message("msg_a", "Latest real prompt", 2)], cursor: {} }),
  })
  await screen("main task")
  await palette("Undo conversation turn")
  const frame = await screen("Confirmation (type undo)")
  expect(frame).toContain("File mode")
  expect(frame).not.toContain("stops active work")
  expect(frame).toContain("Esc close")
  await confirm("und")
  const failed = await screen("Type undo to confirm.")
  expect(failed).toContain("Ctrl+S undo")
  expect(failed).not.toContain("Ctrl+S retry")
  await view.mockInput.typeText("o")
  await gone(view, "Type undo to confirm.")
})

test("redo does not mention a file mode it lacks and says how to scroll the staged patch", async () => {
  const revert = staged
  const { screen, palette } = await dashboard({
    "GET /api/session": () => ({ data: [{ ...session(), revert }], cursor: {} }),
    "GET /api/session/ses_main": () => ({ data: { ...session(), revert } }),
    "GET /api/session/ses_main/message": () => ({
      data: [message("msg_b", "Later prompt", 3), message("msg_a", "Earlier prompt", 2)],
      cursor: {},
    }),
  })
  await screen("main task")
  await palette("Redo conversation turn")
  const frame = await screen("Confirmation (type redo)")
  expect(frame).not.toContain("File mode")
  expect(frame).not.toContain("Tab chooses")
  expect(frame).toContain("PgUp/PgDn scroll")
})
