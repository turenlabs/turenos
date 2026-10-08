import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { sessionRows, SessionListRenderable } from "../src/session-list"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { assistant, cleanup, session, terminal, turen, type Route } from "./support"

type Options = {
  width?: number
  height?: number
  count?: number
  running?: number[]
  waiting?: number[]
  agent?: boolean
  tokens?: boolean
  child?: boolean
  server?: boolean
  routes?: Record<string, Route>
  onQuit?: () => void
}

/** A dashboard over `count` sessions in /srv/project, newest first: ses_s0 is the one on screen. */
async function launch(options: Options = {}) {
  const sessions = Array.from({ length: options.count ?? 12 }, (_, index) => ({
    ...session(`s${index}`),
    title: index === 0 ? "Review terminal navigation chrome and the investigation draft" : `Task ${index}`,
    agent: options.agent === false ? undefined : "build",
    location: { directory: "/srv/project" },
    time: { created: 1 + index, updated: 100 - index },
    ...(options.child && index === (options.count ?? 12) - 1 ? { parentID: "ses_s0" } : {}),
    ...(options.tokens ? { tokens: { input: 1200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } } : {}),
  }))
  const active = Object.fromEntries((options.running ?? []).map((index) => [sessions[index]!.id, { type: "running" }]))
  const routes: Record<string, Route> = {
    "GET /api/session": () => ({ data: sessions, cursor: {} }),
    "GET /api/session/active": () => ({ data: active }),
    "GET /api/agent": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [{ id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] }],
    }),
    ...options.routes,
  }
  for (const [index, item] of sessions.entries()) {
    const waiting = options.waiting?.includes(index)
    routes[`GET /api/session/${item.id}`] = () => ({ data: item })
    routes[`GET /api/session/${item.id}/message`] = () => ({ data: [assistant(String(index), "hello")], cursor: {} })
    routes[`GET /api/session/${item.id}/task`] = () => ({ data: [], active: [], cursor: {} })
    routes[`GET /api/session/${item.id}/permission`] = () => ({
      data: waiting ? [{ id: `per_${index}`, sessionID: item.id, action: "shell", resources: ["npm test"] }] : [],
    })
    routes[`GET /api/session/${item.id}/question`] = () => ({ data: [] })
    routes[`GET /api/session/${item.id}/input`] = () => ({ data: [] })
  }
  const server = turen({ routes })
  const { view, screen } = await terminal(options.width ?? 120, options.height ?? 36, !!options.onQuit)
  const app = mountDashboard(
    view.renderer,
    connect({ url: server.url }),
    server.url,
    options.onQuit,
    options.server ? { server: "127.0.0.1:5555", servers: () => {} } : {},
  )
  cleanup.push(app.dispose)
  await app.ready
  // Below 90 columns the sidebar is hidden and the reply editor opens by itself.
  await screen(options.waiting ? "Needs input" : (options.width ?? 120) < 90 ? "Esc shortcuts" : "Task 1")
  const settle = async () => {
    await Bun.sleep(60)
    await view.renderOnce()
  }
  return {
    view,
    screen,
    app,
    sessions,
    settle,
    frame: () => view.captureCharFrame(),
    /** Esc leaves the reply editor, which the dashboard opens by itself below 90 columns; keys then work as shortcuts. */
    async leave() {
      await settle()
      if (!view.captureCharFrame().includes("Esc shortcuts")) return
      view.mockInput.pressEscape()
      await settle()
    },
    async press(key: string) {
      view.mockInput.pressKey(key)
      await settle()
    },
  }
}

const lineWith = (frame: string, text: string) => frame.split("\n").find((line) => line.includes(text)) ?? ""

test("a long sidebar row is cut with an ellipsis, its marker and selection prefix counted in the width", async () => {
  const view = await createTestRenderer({ width: 30, height: 8 })
  cleanup.push(() => view.renderer.destroy())
  const list = new SessionListRenderable(view.renderer)
  view.renderer.root.add(list)
  const item = { ...session("a"), title: "Review terminal navigation chrome and the investigation draft" }
  list.options = sessionRows([item], { [item.id]: {} })
  await view.renderOnce()
  await view.renderOnce()
  const row = lineWith(view.captureCharFrame(), "> * Review").trimEnd()
  expect(row.endsWith("…")).toBe(true)
  expect(row).not.toContain("...")
  expect(row.length).toBeLessThanOrEqual(29)
  // The cut leaves the start of the title, so two long titles stay distinguishable by what they say first.
  expect(row).toContain("> * Review terminal")
})

test("the sidebar says what * and ? mean, and only when a row carries them", async () => {
  const quiet = await launch({})
  expect(quiet.frame()).not.toContain("* running")
  const running = await launch({ running: [2] })
  await running.app.refresh()
  await running.settle()
  expect(running.frame()).toContain("* running")
  expect(running.frame()).not.toContain("needs input")
  const waiting = await launch({ running: [2], waiting: [2] })
  await waiting.app.refresh()
  await waiting.settle()
  expect(waiting.frame()).toContain("* running · ? needs input")
})

test("the view names are the same prefixes of Sessions, Terminals and Automations at every width", async () => {
  const mid = await launch({ width: 120 })
  const tabs = lineWith(mid.frame(), "2 Term")
  expect(tabs).toContain("[1 Sess]")
  expect(tabs).toContain("3 Auto")
  expect(tabs).not.toContain("Chat")
  const wide = await launch({ width: 160 })
  expect(lineWith(wide.frame(), "2 Terminals")).toContain("[1 Sessions] 2 Terminals  3 Automations")
})

test("the Terminals and Automations tabs offer their own action and heading, not a new session", async () => {
  const app = await launch({})
  await app.leave()
  await app.press("2")
  let frame = await app.screen("+ New terminal    a")
  expect(frame).toContain("/ Find a terminal")
  expect(frame).not.toContain("+ New session")
  expect(frame).not.toContain("Welcome to TurenOS")
  expect(frame.split("\n").some((line) => line.trim().startsWith("Terminals"))).toBe(true)
  await app.press("3")
  frame = await app.screen("+ New automation    a")
  expect(frame).toContain("/ Find an automation")
  expect(frame).not.toContain("+ New session")
  expect(frame).not.toContain("Welcome to TurenOS")
})

test("the narrow drawer lists as many sessions as fit, with its scrollbar in a column of its own", async () => {
  const app = await launch({ width: 80, height: 24, count: 18 })
  await app.leave()
  await app.press("b")
  const frame = await app.screen("Sessions · 18 · b close")
  expect(frame.match(/Task \d+/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  const rows = frame.split("\n").filter((line) => /│\s+(>\s|\s\s)(\* )?Task \d+/.test(line))
  // Rows end before the last column, which holds the scrollbar.
  for (const row of rows) expect(row.trimEnd().length).toBeLessThan(frame.split("\n")[0]!.length - 3)
})

test("the Working folders row says what the folder list holds", async () => {
  const stored = (directories: string[]) => ({
    state: {
      scope: "desktop/store/working-folders",
      key: "open",
      value: JSON.stringify({ version: 1, directories }),
      revision: 1,
      timeCreated: 1,
      timeUpdated: 1,
    },
  })
  const none = await launch({})
  expect(none.frame()).toContain("Working folders · all shown")
  const some = await launch({ routes: { "GET /global/storage": () => stored(["/srv/project"]) } })
  await some.app.refresh()
  await some.settle()
  expect(some.frame()).toContain("Working folders · 1 open")
})

test("an empty New session form is not kept, and a typed one is", async () => {
  const app = await launch({})
  await app.leave()
  await app.press("n")
  await app.screen("What would you like to do?")
  app.view.mockInput.pressEscape()
  await app.settle()
  expect(app.frame()).not.toContain("Draft kept")
  expect(app.frame()).not.toContain("Resume draft")
  expect(app.frame()).toContain("+ New session")
  await app.press("n")
  await app.screen("What would you like to do?")
  await app.view.mockInput.typeText("write the notes")
  app.view.mockInput.pressEscape()
  await app.settle()
  expect(app.frame()).toContain("Draft kept")
  expect(app.frame()).toContain("+ Resume draft    n")
})

test("the top bar shows host:port before it gives up the Sessions button for the port alone", async () => {
  const app = await launch({ width: 80, height: 24, running: [1, 2], waiting: [1, 2], server: true })
  await app.settle()
  const header = app.frame().split("\n")[1]!
  expect(header).toContain("● 127.0.0.1:5555")
  expect(header).toContain("2 running")
  const narrow = await launch({ width: 60, height: 24, running: [1, 2], waiting: [1, 2], server: true })
  await narrow.settle()
  const row = narrow.frame().split("\n")[1]!
  expect(row).not.toContain("…")
  expect(row).not.toContain("...")
  expect(row).toMatch(/● (127\.0\.0\.1)?:5555|● {2}/)
})

test("the switcher leads with the session on screen, names its agent, and marks running like the sidebar", async () => {
  const app = await launch({ agent: false, running: [1], child: true })
  // Choosing the next row in the sidebar makes ses_s0 the session before it.
  app.view.mockInput.pressArrow("down")
  await app.settle()
  expect(app.frame().split("\n")[2]).toContain("Task 2")
  await app.leave()
  app.view.mockInput.pressKey("k", { ctrl: true })
  const frame = await app.screen("Switch session")
  const rows = frame.split("\n").filter((line) => line.includes("Task") || line.includes("Review terminal"))
  expect(rows[0]).toContain("Task 2 · current")
  expect(rows[0]).not.toContain("*")
  expect(rows[1]).toContain("▶ * Task 1")
  expect(frame).toContain("main sessions")
  // The session before it has no recorded agent, and the one on screen answered as `build`.
  expect(frame).toContain("running · ses_s1")
  expect(frame).not.toContain("Default agent")
  app.view.mockInput.pressArrow("up")
  await app.settle()
  expect(app.frame()).toContain("agent build · ses_s2")
})

test("New session settings do not repeat the directory, keep every row visible and name what Esc keeps", async () => {
  const app = await launch({ server: true })
  await app.leave()
  await app.press("n")
  await app.screen("What would you like to do?")
  expect(app.frame()).toContain("Tab settings")
  expect(app.frame()).toContain("Esc keep draft")
  app.view.mockInput.pressTab()
  const frame = await app.screen("Directory on the server")
  expect(frame).not.toContain("Directory: ")
  expect(frame).not.toContain("Tab settings")
  expect(frame).toContain("New git worktree")
  // The dialog fits, so its form needs no scrollbar.
  expect(frame).not.toContain("█")
  expect(lineWith(frame, "TurenOS")).toContain("Sessions (Esc, Ctrl+K)")
  expect(lineWith(frame, "TurenOS")).toContain("Servers (Esc, s)")
})

test("Details counts tokens without a double colon, omits a zero it cannot know and dates each fact once", async () => {
  const empty = await launch({ height: 40 })
  await empty.leave()
  await empty.press("i")
  const none = await empty.screen("SERVER")
  expect(none).not.toContain("Tokens:")
  expect(none).not.toContain("Updated:")
  expect(none).toMatch(/Last activity: \d{4}-\d\d-\d\d \d\d:\d\d/)
  expect(none).toMatch(/Refreshed: \d{4}-\d\d-\d\d \d\d:\d\d/)
  const counted = await launch({ tokens: true, height: 40 })
  await counted.leave()
  await counted.press("i")
  const frame = await counted.screen("SERVER")
  expect(frame).toContain("Tokens: 1,200 in · 30 out")
  expect(frame).not.toContain("in:")
})

test("a discarded-draft message does not outlive the next key", async () => {
  const app = await launch({ width: 80, height: 24 })
  await app.view.mockInput.typeText("scrap this")
  app.view.mockInput.pressKey("F4")
  await app.screen("Local draft discarded.")
  // The reply editor opens again by itself and keeps the message on screen until a key says it is read.
  await app.screen("Esc shortcuts")
  await app.view.mockInput.typeText("fresh")
  await app.settle()
  expect(app.frame()).toContain("fresh")
  expect(app.frame()).not.toContain("Local draft discarded.")
})

test("the Esc-again prompt goes when the turn it offered to stop has ended", async () => {
  const routes = { active: { value: { ses_s0: { type: "running" } } as Record<string, unknown> } }
  const app = await launch({
    running: [0],
    routes: { "GET /api/session/active": () => ({ data: routes.active.value }) },
  })
  await app.app.refresh()
  app.view.mockInput.pressEscape()
  await app.screen("Press Esc again to stop this turn")
  routes.active.value = {}
  await app.app.refresh()
  await app.settle()
  expect(app.frame()).not.toContain("Press Esc again to stop this turn")
})

test("while a quit with a draft is armed the footer says what the next press does, and stops when it lapses", async () => {
  let quit = 0
  const app = await launch({ onQuit: () => quit++ })
  await app.leave()
  await app.press("n")
  await app.screen("What would you like to do?")
  await app.view.mockInput.typeText("unsent words")
  app.view.mockInput.pressEscape()
  await app.settle()
  expect(app.frame()).toContain("q quit")
  await app.press("q")
  const footer = app.frame().split("\n").at(-2)!
  expect(footer).toContain("q again quits and discards")
  expect(quit).toBe(0)
  await Bun.sleep(3300)
  await app.view.renderOnce()
  expect(app.frame()).not.toContain("q again quits")
  expect(app.frame()).toContain("q quit")
})
