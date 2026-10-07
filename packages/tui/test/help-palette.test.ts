import { SelectRenderable, type Renderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { helpSections } from "../src/menus/help-text"
import { connect } from "../src/server"
import { assistant, cleanup, dashboard, terminal, turen } from "./support"

async function open(width: number, height: number, routes = {}) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  return { view, screen }
}

function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child as Renderable)])
}

const transcript = {
  "GET /api/session/ses_main/message": () => ({ data: [assistant("a", "Selectable transcript words")], cursor: {} }),
}

async function drag() {
  const { view, screen } = await open(120, 36, transcript)
  const frame = await screen("Selectable transcript words")
  const row = frame.split("\n").findIndex((line) => line.includes("Selectable transcript words"))
  const start = frame.split("\n")[row]!.indexOf("Selectable")
  expect(frame).not.toContain("Typing")
  return { view, screen, row, start }
}

test("a drag-selection on the transcript survives: the press does not open the reply editor", async () => {
  const { view, row, start } = await drag()
  await view.mockMouse.drag(start, row, start + 7, row)
  // The editor used to open on the next refresh, docking under the transcript and dropping the selection.
  await Bun.sleep(1500)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Typing")
  expect(view.renderer.getSelection()?.getSelectedText()).toBe("Selectab")
  view.mockInput.pressKey("y", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Terminal copy")
})

test("a plain click on the transcript still opens the reply editor", async () => {
  const { view, screen, row, start } = await drag()
  await view.mockMouse.click(start, row)
  await screen("Typing")
})

test("help keys leave a gap before their text, Esc appears once in Essentials, Ctrl+O rows name their context", async () => {
  const { view, screen } = await open(110, 130)
  view.mockInput.pressKey("?")
  const frame = await screen("Keyboard shortcuts")
  const lines = frame.split("\n")
  const column = lines.find((line) => line.includes("a session in view"))!.indexOf("a session in view")
  for (const [keys, text] of helpSections.flatMap(([, rows]) => rows).filter(([keys]) => keys)) {
    const line = lines.find((item) => item.includes(text.slice(0, 14)))
    expect(line, text).toBeDefined()
    expect(line!.indexOf(text.slice(0, 14)), `${keys} ${text}`).toBe(column)
    expect(line!.slice(column - 2, column), keys).toBe("  ")
  }
  const rows = helpSections.flatMap(([, section]) => section)
  expect(helpSections[0]![1].filter(([keys]) => keys === "Esc")).toHaveLength(1)
  expect(rows.filter(([keys]) => keys === "Ctrl+O").every(([, text]) => text.startsWith("in "))).toBe(true)
})

test("help shows where you are among its pages", async () => {
  const { view, screen } = await open(100, 24)
  view.mockInput.pressKey("?")
  const first = await screen("Keyboard shortcuts")
  const total = /1\/(\d+) · More below · PgUp\/PgDn scroll/.exec(first)?.[1]
  expect(Number(total)).toBeGreaterThan(2)
  view.mockInput.pressKey("\u001b[6~")
  await screen(`2/${total} · More below`)
  for (let page = 2; page < Number(total); page++) view.mockInput.pressKey("\u001b[6~")
  const last = await screen(`${total}/${total} · PgUp/PgDn scroll`)
  expect(last).not.toContain("More below")
})

async function options(width: number, height: number) {
  const { view, screen } = await open(width, height)
  await screen("main task")
  view.mockInput.pressKey("p", { ctrl: true })
  const frame = await screen("Find a command")
  const select = descendants(view.renderer.root).filter((node) => node instanceof SelectRenderable).at(-1)!
  return { frame, names: (select as SelectRenderable).options.map((option) => option.name) }
}

test("every palette row reads Name  · Description (key) with one key style", async () => {
  const { names } = await options(120, 36)
  expect(names).toContain("Switch session  · Jump to a session (Ctrl+K)")
  expect(names).toContain("New session  · Folder, agent, model (n)")
  expect(names).toContain("Older history page  · In History ([)")
  expect(names).toContain("Session harness  · Tools and guidance (H or /harness)")
  expect(names).toContain("Delete session  · Permanently, with its subagents")
  expect(names).toContain("Connect a provider  · API key or OAuth")
  for (const name of names) expect(name, name).toMatch(/^[^·]+  · [A-Z][^·/]+( \([^)]+\))?$/)
})

test("at 60 columns palette descriptions are cut with an ellipsis, never mid-word, and keys survive", async () => {
  const { frame, names } = await options(60, 24)
  const row = frame.split("\n").find((line) => line.includes("Archive / restore session"))!
  const archive = names.find((name) => name.startsWith("Archive / restore session"))!
  expect(row).toContain(archive)
  expect(archive).toMatch(/…$|history$/)
  for (const name of names) expect(name.length, name).toBeLessThanOrEqual(48)
  expect(names.find((name) => name.startsWith("Switch session"))).toEndWith("(Ctrl+K)")
})

test("Enter in the Automations list opens the manage menu at once", async () => {
  const loop = {
    id: "loop_1",
    name: "Nightly check",
    prompt: "Run the tests",
    location: { directory: "/srv/main" },
    status: "active",
    schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
  }
  const { view, screen } = await dashboard({ "GET /api/loop": () => [loop], "GET /api/loop/loop_1/run": () => [] })
  view.mockInput.pressKey("3")
  await screen("Enter manage (run now, pause, edit, runs)")
  view.mockInput.pressEnter()
  await screen("Run now")
})

test("Enter in the Terminals list attaches to the selected terminal at once", async () => {
  const shell = { id: "pty_1", title: "build", command: "zsh", args: [], cwd: "/srv/main", status: "running", pid: 42 }
  const { server, view, screen } = await dashboard({
    "GET /api/pty": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [shell],
    }),
  })
  view.mockInput.pressKey("2")
  await screen("Enter attaches (Ctrl+] detaches)")
  view.mockInput.pressEnter()
  for (let wait = 0; wait < 100 && !server.paths().some((path) => path.startsWith("/api/pty/pty_1")); wait++)
    await Bun.sleep(20)
  expect(server.paths().filter((path) => path.startsWith("/api/pty/pty_1")).length).toBeGreaterThan(0)
})
