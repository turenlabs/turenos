import { expect, test } from "bun:test"
import { footerShortcuts } from "../src/chrome"
import { mountDashboard } from "../src/index"
import { fitContext } from "../src/layout/context-line"
import { connect } from "../src/server"
import { assistant, cleanup, session, terminal, turen } from "./support"

const activeMain = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }

async function mount(width: number, routes = {}, height = 24, address = "", ready = "says hello") {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height, true)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, undefined, {
    server: address || server.url.replace("http://", ""),
  })
  cleanup.push(app.dispose)
  await app.ready
  await screen(ready)
  return { view, screen, server }
}

test("the header keeps the port when only the port fits, with the busiest running text", async () => {
  const waiting = {
    ...activeMain,
    "GET /api/session/ses_main/permission": () => ({
      data: [{ id: "per_1", sessionID: "ses_main", action: "shell", resources: ["npm test"] }],
    }),
  }
  const { screen } = await mount(60, waiting, 24, "a-workstation-with-a-long-name.example.internal:4097", "Needs input")
  const header = (await screen("1 need input")).split("\n")[1]
  expect(header).toContain("● :4097")
  expect(header).not.toContain("example")
})

test("the footer keeps ? help beside the status text at 60 columns, and in every set that has room", async () => {
  for (const width of [60, 70, 80, 120])
    for (const sidebar of [true, false]) expect(footerShortcuts(width, sidebar, false, false, false, 17)).toContain("? help")
  expect(footerShortcuts(60, false, false, false, false, 17)).toBe("Ctrl+P commands · b sidebar · ? help")
  expect(footerShortcuts(60, false, false, false, false, 40)).toBe("? help")
  const live = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) =>
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_1", type: "server.connected", data: {} })}\n\n`)),
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  const { view, screen } = await mount(60, { "GET /api/event": live })
  view.mockInput.pressKey("ESCAPE")
  const footer = (await screen("? help")).trimEnd().split("\n").at(-1)!
  expect(footer).toBe("  View 1/3 Sessions   Ctrl+P commands · b sidebar · ? help")
})

test("an armed quit reads q again quits in the shortcuts", () => {
  expect(footerShortcuts(120, false, false, false, true)).toContain("q again quits")
  expect(footerShortcuts(120, false)).toContain("q quit")
  expect(footerShortcuts(120, false, true, false, true)).toContain("Ctrl+C again quits")
  expect(footerShortcuts(120, false, true, true, true)).not.toContain("Ctrl+C stop")
})

test("the context line cuts the folder from its start and keeps the state words and cue whole", () => {
  const text = "Transcript · /run/user/1000/turen-tui-sandbox/rd2/project · ↑ scrolled up · End for latest"
  expect(fitContext(text, 60)).toBe("Transcript · …/rd2/project · ↑ scrolled up · End for latest")
  expect(fitContext(text, 55)).toBe("Transcript · …/project · ↑ scrolled up · End for latest")
  expect(fitContext(text, 54)).toBe("Transcript · ↑ scrolled up · End for latest")
  expect(fitContext(text, 200)).toBe(text)
})

test("the context line shows the scrolled-up cue whole beside a shortened folder at 60 columns", async () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n")
  const deep = { ...session("main"), location: { directory: "/run/user/1000/turen-tui-sandbox/rd2/project" } }
  const { view, screen } = await mount(60, {
    "GET /api/session": () => ({ data: [deep], cursor: {} }),
    "GET /api/session/ses_main": () => ({ data: deep }),
    "GET /api/session/ses_main/message": () => ({
      data: [assistant("long", long)],
      cursor: {},
    }),
  }, 24, "", "line 79")
  await screen("line 79")
  view.mockInput.pressKey("ESCAPE")
  await screen("f Reply")
  view.mockInput.pressKey("\x1b[5~")
  const frame = await screen("scrolled up")
  const line = frame.split("\n").find((item) => item.includes("scrolled up"))!
  expect(line).toContain("Transcript · …/project · ↑ scrolled up · End for latest")
  expect(line).not.toContain("...")
})

test("sidebar / opens the same switcher as Ctrl+K, not one docked inside the sidebar", async () => {
  const { view, screen } = await mount(120, {}, 30)
  await screen("Focus: sidebar")
  view.mockInput.pressKey("/")
  const slash = await screen("Switch session")
  expect(slash).not.toContain("││")
  expect(slash).not.toContain("│╭")
  const column = slash.split("\n").find((line) => line.includes("Switch session"))!.indexOf("╭")
  view.mockInput.pressKey("ESCAPE")
  await Bun.sleep(60)
  view.mockInput.pressKey("k", { ctrl: true })
  const ctrlK = await screen("Switch session")
  expect(ctrlK.split("\n").find((line) => line.includes("Switch session"))!.indexOf("╭")).toBe(column)
})

test("the drawer scrollbar thumb keeps its own column, clear of every row's text", async () => {
  const many = Array.from({ length: 18 }, (_, i) => session(i ? `s${i}` : "main"))
  const { view, screen } = await mount(80, { "GET /api/session": () => ({ data: many, cursor: {} }) })
  view.mockInput.pressKey("ESCAPE")
  await screen("f Reply")
  view.mockInput.pressKey("b")
  const frame = await screen("b close")
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes("b close"))
  const drawer = lines.slice(start, -2)
  const column = drawer.map((line) => line.indexOf("▀")).find((index) => index >= 0)!
  expect(column).toBeGreaterThan(0)
  for (const line of drawer) expect(line.slice(column - 1).trim().replace("▀", "")).toBe("")
})

test("an armed quit says q again quits in the shortcuts, and q quit returns when it lapses", async () => {
  const { view, screen } = await mount(120, activeMain, 30)
  await screen("Focus: sidebar")
  view.mockInput.pressKey("q")
  const armed = await screen("The agent is still working")
  const footer = armed.split("\n").at(-2)!
  expect(footer).toContain("q again quits")
  expect(footer).toContain("? help · q again quits")
  expect(footer).not.toContain("q quit")
  await Bun.sleep(3300)
  const lapsed = await screen("? help · q quit")
  expect(lapsed.split("\n").at(-2)).not.toContain("q again quits")
})
