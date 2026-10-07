import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen, until, type Route } from "./support"

async function sized(width: number, height: number, routes: Record<string, Route>) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  if (width < 90) {
    // Below 90 columns the transcript has focus, so the reply editor is open until Esc.
    await screen("Reply to main task")
    view.mockInput.pressEscape()
    await until(() => !view.captureCharFrame().includes("Reply to main task"))
  }
  return { view, screen }
}

const lines = (frame: string) => frame.split("\n").map((line) => line.replace(/[│╭╮╰╯─]/g, "").trim())

const files: Record<string, Route> = {
  "GET /file": () => [
    { name: "src", path: "src/", absolute: "/srv/main/src", type: "directory", ignored: false },
    { name: "README.md", path: "README.md", absolute: "/srv/main/README.md", type: "file", ignored: false },
  ],
  "GET /file/content": () => ({ type: "text", content: "# Readme" }),
}

for (const [width, height] of [
  [120, 36],
  [80, 24],
  [60, 24],
] as const)
  test(`Files shows one selection marker and whole key hints at ${width}x${height}`, async () => {
    const { view, screen } = await sized(width, height, files)
    view.mockInput.pressKey("e")
    const frame = await screen("README.md")
    expect(frame).not.toContain("▶ ▸")
    expect(frame).toContain("▶ src/")
    expect(lines(frame).some((line) => line === "Esc close" || line.endsWith("· Esc close"))).toBe(true)
    expect(lines(frame).some((line) => line.startsWith("·") || line === "close")).toBe(false)
    expect(frame.split("\n").every((line) => line.trimEnd().length <= width)).toBe(true)
  })

for (const [width, height] of [
  [120, 36],
  [80, 24],
  [60, 24],
] as const)
  test(`the session picker keeps whole hints, ▶ and ·, no lone heading, and the session's details at ${width}x${height}`, async () => {
    const { view, screen } = await sized(width, height, {})
    view.mockInput.pressKey("k", { ctrl: true })
    const frame = await screen("Switch session")
    const text = lines(frame)
    expect(frame).toContain("▶ main task · current")
    expect(frame).not.toContain("| current")
    expect(text).not.toContain("main")
    expect(frame).toContain("/srv/main")
    expect(frame).toContain("ses_main")
    expect(text.some((line) => line.endsWith("Esc close"))).toBe(true)
    expect(text.some((line) => /(^|\s)(Ctrl\+Home\/|PgUp\/)$/.test(line))).toBe(false)
  })

test("details list each fact once under SESSION, PROJECT and SERVER headers at 60x24", async () => {
  const { view, screen } = await sized(60, 24, {})
  view.mockInput.pressKey("i")
  const frame = await screen("SERVER")
  for (const heading of ["SESSION", "PROJECT", "SERVER"]) expect(frame).toContain(heading)
  expect(frame.match(/\/srv\/main/g)).toHaveLength(1)
  expect(frame).toMatch(/Created: \d{4}-\d\d-\d\d \d\d:\d\d/)
  expect(frame).toMatch(/Updated: \d{4}-\d\d-\d\d \d\d:\d\d/)
  expect(frame).not.toMatch(/\d+\/\d+\/\d{4}/)
})

test("terminal and automation cards name their keys, label the id and drop repeated lines", async () => {
  const shell = { id: "pty_1", title: "build", command: "zsh", args: [], cwd: "/srv/main", status: "running", pid: 42 }
  const loop = {
    id: "loop_1",
    name: "Nightly check",
    prompt: "Run the tests",
    location: { directory: "/srv/main" },
    status: "active",
    schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
    nextRunAt: Date.UTC(2026, 9, 4, 13, 56),
  }
  const { view, screen } = await sized(100, 30, {
    "GET /api/pty": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [shell],
    }),
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [
      { id: "lrn_9", loopID: "loop_1", status: "succeeded", trigger: "schedule", time: { created: 1 } },
    ],
  })
  view.mockInput.pressKey("2")
  const terminals = await screen("a add terminal")
  expect(terminals).toContain("ID pty_1")
  expect(terminals.match(/\/srv\/main/g)).toHaveLength(1)
  view.mockInput.pressKey("3")
  const automations = await screen("RECENT RUNS")
  expect(automations).toContain("ID loop_1")
  expect(automations).toContain("a add · E edit · d delete")
  expect(automations).not.toContain("lrn_9")
  expect(automations).toMatch(/Next run: \d{4}-\d\d-\d\d \d\d:\d\d/)
  expect(automations.match(/Nightly check/g)?.length).toBeLessThanOrEqual(2)
})

test("the automation form marks the focused field in plain text", async () => {
  const { view, screen } = await sized(80, 24, {})
  view.mockInput.pressKey("3")
  await screen("No automations yet")
  view.mockInput.pressKey("a")
  expect(await screen("New automation")).toContain("▶ Name")
  view.mockInput.pressTab()
  const frame = await screen("▶ Prompt the agent runs each time")
  expect(frame).not.toContain("▶ Name")
})

test("the session picker refits its hint when the terminal shrinks while open", async () => {
  const { view, screen } = await sized(120, 36, {})
  view.mockInput.pressKey("k", { ctrl: true })
  await screen("Switch session")
  view.resize(80, 24)
  for (let frame = 0; frame < 4; frame++) await view.renderOnce()
  const text = lines(view.captureCharFrame())
  expect(text.some((line) => line.endsWith("Esc close"))).toBe(true)
  expect(text.some((line) => /(^|\s)(Ctrl\+O|Ctrl\+Home\/|PgUp\/)$/.test(line))).toBe(false)
  expect(text.every((line) => line.length <= 80)).toBe(true)
})
