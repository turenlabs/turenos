import { expect, test } from "bun:test"
import { session, sized, until, type Route } from "./support"

const loop = {
  id: "loop_1",
  name: "Nightly",
  prompt: "Run the tests",
  location: { directory: "/srv/main" },
  status: "active",
  schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
}
const automations: Record<string, Route> = {
  "GET /api/loop": () => [loop],
  "GET /api/loop/loop_1/run": () => [
    {
      id: "lrn_1",
      loopID: "loop_1",
      status: "succeeded",
      trigger: "schedule",
      time: { created: 1 },
      sessionID: "ses_run",
    },
    {
      id: "lrn_2",
      loopID: "loop_1",
      status: "succeeded",
      trigger: "schedule",
      time: { created: 2 },
      sessionID: "ses_run",
    },
  ],
}

async function manage(width = 100, height = 30) {
  const app = await sized(width, height, automations)
  app.view.mockInput.pressKey("3")
  await app.screen("Enter manage")
  app.view.mockInput.pressKey("p", { ctrl: true })
  await app.view.mockInput.typeText("Manage automation")
  app.view.mockInput.pressEnter()
  await app.screen("Run now")
  return app
}

test("the automation menu names its automation and Esc from Runs and Edit returns to it", async () => {
  const { view, screen } = await manage()
  const menu = await screen("Automation › Nightly")
  expect(menu).toContain("Pause")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const runs = await screen("succeeded")
  expect(runs.match(/Enter opens its session/g)).toBeNull()
  view.mockInput.pressKey("ESCAPE")
  await screen("Run now")
  // The cursor is back on Runs, so the next row down is Edit.
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  expect(await screen("Edit")).toContain("Esc back")
  view.mockInput.pressKey("ESCAPE")
  await screen("Run now")
  view.mockInput.pressKey("ESCAPE")
  await until(() => !view.captureCharFrame().includes("Run now"))
})

test("a post typed in the swarm room survives Esc and comes back on reopening", async () => {
  const { view, screen } = await sized(120, 36, {})
  await screen("main task")
  view.mockInput.pressEnter()
  await screen("Typing")
  view.mockInput.pressEscape()
  await until(() => !view.captureCharFrame().includes("Typing"))
  await view.mockInput.typeText("w")
  await screen("Swarm room")
  await screen("No swarm room")
  view.mockInput.pressTab()
  await view.mockInput.typeText("half a thought")
  await screen("half a thought")
  view.mockInput.pressKey("ESCAPE")
  await until(() => !view.captureCharFrame().includes("Swarm room"))
  await view.mockInput.typeText("w")
  await screen("half a thought")
  await screen("No swarm room")
})

test("Files goes up with Backspace and refreshes with Ctrl+R, and its hint says so", async () => {
  let listings = 0
  const { server, view, screen } = await sized(120, 36, {
    "GET /file": (_, url) => {
      listings++
      return url.searchParams.get("path")
        ? [{ name: "a.ts", path: "src/a.ts", absolute: "/srv/main/src/a.ts", type: "file", ignored: false }]
        : [{ name: "src", path: "src/", absolute: "/srv/main/src", type: "directory", ignored: false }]
    },
    "GET /file/content": () => ({ type: "text", content: "export {}" }),
  })
  view.mockInput.pressKey("e")
  const frame = await screen("▶ src/")
  expect(frame).toContain("Backspace")
  expect(frame).toContain("Ctrl+R")
  view.mockInput.pressEnter()
  await screen("▶ a.ts")
  const before = listings
  view.mockInput.pressKey("r", { ctrl: true })
  await until(() => listings > before)
  view.mockInput.pressKey("BACKSPACE")
  await screen("▶ src/")
  expect(server.sent("/file").length).toBeGreaterThan(2)
})

test("Changes names the modes its m key cycles through", async () => {
  const { view, screen } = await sized(120, 36, { "GET /vcs/diff": () => [] })
  view.mockInput.pressKey("d")
  const frame = await screen("m mode")
  for (const mode of ["uncommitted", "branch", "last turn"]) expect(frame).toContain(mode)
})

for (const [width, height] of [
  [120, 36],
  [80, 24],
] as const)
  test(`Tools keeps its frame and hint inside the screen with a long list at ${width}x${height}`, async () => {
    const visible = Array.from({ length: 60 }, (_, index) => ({
      id: `tool_${index}`,
      source: "builtin",
      description: "A description long enough to wrap across several lines of the tools dialog ".repeat(3),
    }))
    const { view, screen } = await sized(width, height, {
      "GET /api/session": () => ({
        data: [{ ...session(), model: { providerID: "openai", id: "gpt" } }],
        cursor: {},
      }),
      "GET /experimental/tool": () => ({
        agent: "build",
        providerID: "openai",
        modelID: "gpt",
        visible,
        mcpServers: [],
        exclusions: [],
      }),
    })
    await screen("main task")
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText("Session tools")
    view.mockInput.pressEnter()
    const frame = await screen("tool_0")
    const rows = frame.split("\n")
    expect(rows.some((row) => row.includes("Esc close"))).toBe(true)
    expect(rows.some((row) => row.trimStart().startsWith("╰"))).toBe(true)
    await view.mockInput.pressKeys(["\x1b[6~"])
    for (let frame = 0; frame < 4; frame++) await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("tool_0 ·")
  })

test("Working folders names its mode in the title and says when no folder is open", async () => {
  const { server, view, screen } = await sized(120, 36, {})
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("folders")
  view.mockInput.pressEnter()
  const open = await screen("Working folders › Open")
  expect(open).toContain("No folders are open yet, so the sidebar shows every session")
  view.mockInput.pressKey("r", { ctrl: true })
  expect(await screen("Working folders › Close")).not.toContain("Working folders › Open")
  // Let the folder read finish before the renderer is torn down.
  await until(() => server.sent("/global/storage").length > 0)
  await Bun.sleep(100)
})
