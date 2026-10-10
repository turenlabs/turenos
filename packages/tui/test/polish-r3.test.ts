import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mountApp } from "../src/index"
import { createServers } from "../src/servers"
import { cleanup, dashboard, mount, terminal, turen } from "./support"
import { todoText } from "../src/session-actions/todos"

const location = { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } }
const routes = {
  "GET /api/command": () => ({ location, data: [{ name: "review", description: "x", template: "x", subtask: false }] }),
}

test("a: whole command typed in one go, list loaded, one Enter", async () => {
  const { view, screen } = await dashboard(routes)
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/tools")
  await screen("▶ /tools")
  view.mockInput.pressEnter()
  await screen("─ Tools ─")
  await Bun.sleep(300)
})

test("b: no wait between chars and Enter", async () => {
  const { view, screen } = await dashboard(routes)
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/")
  await screen("▶ /help")
  await view.mockInput.typeText("tools")
  view.mockInput.pressEnter()
  await screen("─ Tools ─")
  await Bun.sleep(300)
})

test("c: Tab completion then Enter", async () => {
  const { view, screen } = await dashboard(routes)
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/tool")
  await screen("▶ /tools")
  view.mockInput.pressTab()
  await Bun.sleep(100)
  view.mockInput.pressEnter()
  await screen("─ Tools ─")
  await Bun.sleep(300)
})

test("an action row that drops entries ends with an ellipsis", async () => {
  const { view, screen } = await mount(60, {
    "GET /api/session/ses_main/input": () => ({
      data: [1, 2].map((seq) => ({
        admittedSeq: seq,
        id: `msg_${seq}`,
        sessionID: "ses_main",
        prompt: { text: "queued" },
        delivery: "queue",
        timeCreated: 1,
      })),
    }),
  })
  view.mockInput.pressEscape()
  const frame = await screen("u 2 queued")
  const row = frame.split("\n").find((line) => line.includes("u 2 queued"))!
  // The queued count leads; History and Details are the first entries to give way.
  expect(row).not.toContain("i Details")
  expect(row).not.toContain("[object Object]")
  expect(row.trimEnd()).toMatch(/ …\s*(│|$)/)
  view.resize(120, 36)
  const wide = await screen("i Details")
  expect(wide.split("\n").find((line) => line.includes("i Details"))).not.toContain("…")
})

test("every to-do state puts its glyph and its text in the same columns", () => {
  const rows = todoText(
    (["pending", "in_progress", "completed", "cancelled"] as const).map((status) => ({
      content: "Same text",
      status,
      priority: "high",
    })),
  )
    .split("\n")
    .slice(1)
  expect(new Set(rows.map((row) => row.search(/[○◐●×]/))).size).toBe(1)
  expect(new Set(rows.map((row) => row.indexOf("Same text"))).size).toBe(1)
})

test("a connected provider row reads like the other rows", async () => {
  const { view, screen } = await dashboard({
    "GET /provider": () => ({
      all: [{ id: "claude-code", name: "Claude Code", models: {} }],
      connected: ["claude-code"],
    }),
  })
  await screen("main task")
  view.mockInput.pressKey("n")
  await screen("What would you like to do?")
  view.mockInput.pressKey("l", { ctrl: true })
  await screen("F2")
  view.mockInput.pressKey("F2")
  const list = await screen("+ Add custom provider")
  expect(list).toContain("connected · Enter replaces credentials")
  expect(list).not.toContain("connected;")
})

test("the Add server form has its own line instead of the picker's subtitle", async () => {
  const home = await mkdtemp(join(tmpdir(), "turen-tui-polish-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const alpha = turen({ name: "alpha", password: "secret" })
  const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "attach.json"),
    JSON.stringify({ version: 1, url: alpha.listener.url.origin, username: "forge", password: "secret", pid: process.pid }),
    { mode: 0o600 },
  )
  const servers = createServers({ home, platform: "darwin", env: {}, forge: null, config: join(home, "servers.json") })
  const { view, screen } = await terminal()
  const app = mountApp(view.renderer, servers, { initial: await servers.preferred(), onQuit: () => {} })
  cleanup.push(app.dispose)
  await screen("alpha says hello")
  view.mockInput.pressKey("s")
  expect(await screen("choose a server")).toContain("choose a server")
  view.mockInput.pressKey("a")
  const form = await screen("Servers › Add server")
  expect(form).toContain("Add a server by its address")
  expect(form).not.toContain("choose a server")
})

test("the New session prompt sits in a framed field", async () => {
  const { view, screen } = await dashboard({})
  await screen("main task")
  view.mockInput.pressKey("n")
  const frame = await screen("What would you like to do?")
  const rows = frame.split("\n")
  const placeholder = rows.findIndex((line) => line.includes("Describe the task"))
  expect(placeholder).toBeGreaterThan(0)
  // The bar runs beside every row of the empty prompt.
  expect(rows[placeholder]).toMatch(/│ │ Describe the task/)
  expect(rows[placeholder + 1]).toMatch(/│/)
  expect(rows[placeholder + 2]).toMatch(/│/)
})
