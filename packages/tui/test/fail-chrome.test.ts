import { expect, test } from "bun:test"
import { footerShortcuts } from "../src/chrome"
import { fitContext } from "../src/layout/context-line"
import { assistant, mount, session } from "./support"

const activeMain = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }

test("the header keeps the port when only the port fits, with the busiest running text", async () => {
  const waiting = {
    ...activeMain,
    "GET /api/session/ses_main/permission": () => ({
      data: [{ id: "per_1", sessionID: "ses_main", action: "shell", resources: ["npm test"] }],
    }),
  }
  const { screen } = await mount(60, waiting, 24, "a-workstation-with-a-long-name.example.internal:4097", "need input")
  const header = (await screen("1 need input")).split("\n")[1]
  expect(header).toContain("● 4097")
  expect(header).not.toContain("example")
})

test("the footer keeps ? help beside the status text at 60 columns, and in every set that has room", async () => {
  for (const width of [60, 70, 80, 120])
    for (const sidebar of [true, false]) expect(footerShortcuts(width, sidebar, false, 17)).toContain("? help")
  expect(footerShortcuts(60, false, false, 17)).toBe("Ctrl+P commands · b sidebar · ? help")
  expect(footerShortcuts(60, false, false, 40)).toBe("? help")
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
  expect(footer).toContain("1/4 Sessions")
  expect(footer).toContain("Enter type · ? help")
  expect(footer).not.toContain("View")
})

test("the shortcuts keep their quit entries; an armed quit is said once, by the status line", () => {
  expect(footerShortcuts(120, false)).toContain("q quit")
  // The editor row names Esc, so the typing footer adds only the palette.
  expect(footerShortcuts(120, false, true)).toBe("Ctrl+P commands")
})

test("the context line keeps the last two folders below 100 columns, then the whole folder while it fits", () => {
  const text = "/run/user/1000/turen-tui-sandbox/rd2/project · ↑ scrolled up · End for latest"
  expect(fitContext(text, 60)).toBe("…/rd2/project · ↑ scrolled up · End for latest")
  expect(fitContext(text, 40)).toBe("↑ scrolled up · End for latest")
  expect(fitContext(text, 100)).toBe(text)
  expect(fitContext(`History · page 2 · ${text}`, 70)).toStartWith("History · page 2 · …/rd2/project")
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
  await screen("Enter type")
  view.mockInput.pressKey("\x1b[5~")
  const frame = await screen("scrolled up")
  const line = frame.split("\n").find((item) => item.includes("scrolled up"))!
  expect(line).toContain("…/rd2/project · ↑ scrolled up · End for latest")
  expect(line).not.toContain("Transcript")
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
  await screen("Enter type")
  view.mockInput.pressKey("b")
  const frame = await screen("b close")
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes("b close"))
  const drawer = lines.slice(start, -2)
  const column = drawer.map((line) => line.indexOf("▀")).find((index) => index >= 0)!
  expect(column).toBeGreaterThan(0)
  for (const line of drawer) expect(line.slice(column - 1).trim().replace("▀", "")).toBe("")
})

test("an armed quit is said once, in the status line, and the footer does not repeat it", async () => {
  const { view, screen } = await mount(120, activeMain, 30)
  await screen("Focus: sidebar")
  view.mockInput.pressKey("q")
  const armed = await screen("The agent is still working")
  expect(armed.match(/again quits/g) ?? []).toHaveLength(0)
  expect(armed.split("\n").at(-2)).toContain("? help")
  expect(armed.match(/Press q again to quit/g)).toHaveLength(1)
})
