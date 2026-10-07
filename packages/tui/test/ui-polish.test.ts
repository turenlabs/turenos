import { afterEach, expect, test } from "bun:test"
import { footerShortcuts } from "../src/chrome"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, dashboard, session, terminal, turen, type Route } from "./support"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const running = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }

test("the typing footer says Ctrl+C stops while a turn runs and quits otherwise, at every width", () => {
  expect(footerShortcuts(120, true, true, true)).toBe("Esc shortcuts · Ctrl+P commands · Ctrl+C stop")
  expect(footerShortcuts(120, true, true)).toBe("Esc shortcuts · Ctrl+P commands · Ctrl+C quit")
  expect(footerShortcuts(120, true, false, true)).toContain("q quit")
  expect(footerShortcuts(60, true, true, true)).not.toContain("Ctrl+C")
})

async function mounted(routes: Record<string, Route>) {
  const server = turen({ routes })
  const { view, screen } = await terminal(120, 36, true)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, () => {})
  cleanup.push(app.dispose)
  await app.ready
  return { view, screen }
}

test("the dashboard footer switches Ctrl+C between stop and quit as the session starts and stops", async () => {
  const state = { active: true }
  const app = await mounted({
    "GET /api/session/active": () => ({ data: state.active ? { ses_main: { type: "running" } } : {} }),
  })
  app.view.mockInput.pressEnter()
  await app.screen("Ctrl+C stop")
  state.active = false
  const frame = await app.screen("Ctrl+C quit")
  expect(frame).toContain("Typing")
})

test("an open reply editor follows the session's new title", async () => {
  const state = { title: "New session - 2026-10-07T17:35:31.796Z" }
  const app = await mounted({
    "GET /api/session": () => ({ data: [{ ...session(), title: state.title }], cursor: {} }),
    "GET /api/session/ses_main": () => ({ data: { ...session(), title: state.title } }),
  })
  app.view.mockInput.pressEnter()
  await app.screen("Reply to New session")
  state.title = "please run the marker"
  await app.screen("Reply to please run the marker")
  expect(app.view.captureCharFrame()).not.toContain("Reply to New session")
})

test("the quit warning says unsent drafts are kept only until you quit", async () => {
  const { view, screen } = await mounted({})
  view.mockInput.pressEnter()
  await screen("Typing")
  await view.mockInput.typeText("unsent")
  view.mockInput.pressEscape()
  await screen("Focus: transcript")
  view.mockInput.pressKey("q")
  const frame = await screen("Unsent drafts are kept only until you quit.")
  expect(frame).not.toContain("saved locally")
})

test("F4 mentions server work only when the draft's session is running", async () => {
  const idle = await mounted({})
  idle.view.mockInput.pressEnter()
  await idle.screen("Typing")
  await idle.view.mockInput.typeText("draft")
  idle.view.mockInput.pressKey("F4")
  const frame = await idle.screen("Local draft discarded.")
  expect(frame).not.toContain("Server work continues")
  const busy = await mounted(running)
  busy.view.mockInput.pressEnter()
  await busy.screen("Typing")
  await busy.view.mockInput.typeText("draft")
  busy.view.mockInput.pressKey("F4")
  await busy.screen("Local draft discarded. Server work continues.")
})

test("Settings › Appearance states each current setting and fits a narrow dialog", async () => {
  const app = await dashboard({})
  app.view.resize(80, 30)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 7; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Settings › Appearance")
  for (const text of [
    "Motion: on",
    "Enter turns animation off",
    "Attention alerts: on",
    "Bell and title alerts · Enter turns them off",
    "Responses: formatted",
    "Enter shows raw text",
    "Tool output: first lines only (Ctrl+O)",
    "Enter shows it in full",
  ])
    expect(frame).toContain(text)
  app.view.mockInput.pressEnter()
  await app.screen("Motion: off (reduced)")
})

const wing = { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 }
const room = { id: "rom_1", wingID: "wng_1", slug: "tooling", name: "Tooling", timeCreated: 1, timeUpdated: 1 }
const alphabet = Array.from({ length: 900 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("")
const memory = {
  id: "drw_1",
  wingID: "wng_1",
  roomID: "rom_1",
  kind: "decision",
  title: "Long",
  body: `${alphabet}\n${"tui.md ".repeat(100)}`,
  anchor: {},
  provenance: { assertedBy: "build", source: "agent" },
  timeValidFrom: 1,
  timeCreated: 1,
  timeUpdated: 5,
}

test("memory detail text wraps one column short of the scrollbar and loses no characters", async () => {
  const app = await dashboard({
    "GET /api/memory/wing": () => [wing],
    "GET /api/memory/room": () => [room],
    "GET /api/memory": () => [{ ...memory, id: "drw_0", title: "Short", body: "tiny", timeUpdated: 9 }, memory],
  })
  await app.palette("Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("tiny")
  app.view.mockInput.pressArrow("down")
  await app.screen("abcdefghij")
  app.view.resize(100, 36)
  for (let pass = 0; pass < 4; pass++) await app.view.renderOnce()
  const rows = app.view
    .captureCharFrame()
    .split("\n")
    .map((line) => /[a-z]{30,}/.exec(line)?.[0])
    .filter((row) => row !== undefined)
  expect(rows.length).toBeGreaterThan(5)
  expect(rows.join("")).toBe(alphabet.slice(0, rows.join("").length))
})

test("the attachment line ignores the partial @ token while the suggestion list is open", async () => {
  const app = await mounted({
    "GET /api/fs/find": () => ({
      location: { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } },
      data: [{ path: "answer.ts", type: "file" }],
    }),
  })
  app.view.mockInput.pressEnter()
  await app.screen("Typing")
  await app.view.mockInput.typeText("see @ans")
  const frame = await app.screen("answer.ts")
  expect(frame).not.toContain("Attaches ans")
  app.view.mockInput.pressTab()
  await app.screen("Attaches answer.ts")
})

test("the Ctrl+C that stops a turn still says a second press quits once the turn has ended", async () => {
  const state = { active: true }
  const app = await mounted({
    "GET /api/session/active": () => ({ data: state.active ? { ses_main: { type: "running" } } : {} }),
    "POST /api/session/ses_main/interrupt": () => {
      state.active = false
      return new Response(null, { status: 204 })
    },
  })
  app.view.mockInput.pressEnter()
  await app.screen("Ctrl+C stop")
  app.view.mockInput.pressKey("c", { ctrl: true })
  // The footer's typing hint says what the second press does, and keeps saying so once the turn has ended.
  const frame = await app.screen("Session interrupted. Ctrl+C again quits.")
  expect(frame.trimEnd().split("\n").at(-1)).toContain("Ctrl+C again quits")
  expect(frame.trimEnd().split("\n").at(-1)).not.toContain("Ctrl+C stop")
})
