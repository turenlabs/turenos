import { expect, test } from "bun:test"
import { SessionListRenderable } from "../src/session-list"
import { ScrollBoxRenderable, SelectRenderable, TextareaRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, descendants, fixture } from "./dashboard-fixture"

test("resizing below the minimum protects the draft and restores it on return", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep this while resizing")
  view.resize(45, 18)
  await view.renderOnce()
  expect(view.captureCharFrame().replace(/\s+/g, " ")).toContain("58 columns × 24 rows")
  await view.mockInput.typeText("unexpected")
  await view.mockInput.pasteBracketedText("paste must be blocked")
  view.mockInput.pressKey("s", { ctrl: true })
  view.resize(70, 24)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Keep this while resizing")
  expect(view.captureCharFrame()).not.toContain("unexpected")
  expect(view.captureCharFrame()).not.toContain("paste must")
  expect(server.posts).toHaveLength(0)
})

test("mouse navigation matches the view and composer labels", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const click = async (text: string) => {
    await view.renderOnce()
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    await view.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
  }
  await click("2 Ter")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  await click("1 Ses")
  await waitForFrame(view, (frame) => frame.includes("Review the server"))
  const composer = view
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("Message…"))!
  expect(composer).not.toContain("New session")
  const action = descendants(view.renderer.root).find(
    (node) => node instanceof TextRenderable && node.plainText.startsWith("Message…"),
  ) as TextRenderable
  expect(action.plainText).toBe("Message…")
  await click("Message…")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("Keep while switching tabs")
  await click("2 Ter")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  await click("1 Ses")
  // Back on the chat the reply editor reopens by itself with its draft; Esc leaves it for the label.
  await waitForFrame(view, (frame) => frame.includes("Keep while switching tabs"))
  await leaveComposer(view)
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  await click("Draft kept")
  await waitForFrame(view, (frame) => frame.includes("Keep while switching tabs"))
  expect(server.posts).toHaveLength(0)
})

test("command selection remains visible at the minimum supported size", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Refresh")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Refresh")
  expect(view.captureCharFrame()).toContain("Enter run")
  const select = descendants(view.renderer.root)
    .filter((node) => node instanceof SelectRenderable)
    .at(-1)!
  expect(select.options[select.getSelectedIndex()]?.name).toBe("Refresh  · Reload from the server (r)")
  expect(server.posts).toHaveLength(0)
})

test("the default view shows the full live transcript and keeps technical details on demand", async () => {
  const server = fixture({ history: true })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await view.renderOnce()
  const frame = await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  expect(frame).toContain("Inspecting the server")
  expect(frame).toContain("/srv/project")
  expect(frame).not.toContain("ses_running")
  expect(frame).not.toContain(server.server.url.host)
  expect(frame).toContain("test/local")
  expect(frame).toContain("Earlier task")
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("Earlier task"))
  expect(view.captureCharFrame()).toContain("test/local")
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => !frame.includes("History ·"))
  view.mockInput.pressKey("i")
  await waitForFrame(view, (frame) => frame.includes("SERVER"))
  expect(view.captureCharFrame()).toContain("ses_running")
  expect(view.captureCharFrame()).toContain(server.server.url.host)
  expect(server.posts).toHaveLength(0)
})

test("machine responses are formatted by default and raw JSON is opt-in", async () => {
  const raw = '{"status":"completed","result":{"summary":"Checks passed"}}'
  const server = fixture({ toolText: raw })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const frame = await waitForFrame(view, (frame) => frame.includes("Checks passed"))
  expect(frame).toContain("status: completed")
  expect(frame).not.toContain('{"status"')
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Show raw responses")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes(raw))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Show formatted responses")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("status: completed") && !frame.includes('{"status"'))
  expect(server.posts).toHaveLength(0)
})

test("long tool output is folded by default and the palette expands and folds it again", async () => {
  const server = fixture({ toolText: Array.from({ length: 30 }, (_, index) => `output row ${index + 1}`).join("\n") })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  // Fenced output can paint a frame after the fold note, so wait for both.
  const folded = await waitForFrame(view, (frame) => frame.includes("+26 lines") && frame.includes("output row 4"))
  expect(folded).not.toContain("output row 30")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Expand tool output")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("output row 30") && !frame.includes("+26 lines"))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Collapse tool output")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("+26 lines") && !frame.includes("output row 30"))
  expect(server.posts).toHaveLength(0)
})

test("mouse pane focus stays synchronized with Tab and dialog restoration", async () => {
  const server = fixture({ text: "Mouse focus target" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const list = descendants(view.renderer.root).find((node) => node instanceof SessionListRenderable)!
  const detail = descendants(view.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable && !(node instanceof SessionListRenderable),
  )!
  await waitForFrame(view, (frame) => frame.includes("Mouse focus target"))
  await clickText(view, "Mouse focus target")
  expect(detail.focused).toBe(true)
  view.mockInput.pressTab()
  expect(list.focused).toBe(true)
  view.mockInput.pressTab()
  await view.renderOnce()
  const row = descendants(list).find(
    (node) => node instanceof TextRenderable && node.plainText.includes("Review the server"),
  )!
  await view.mockMouse.click(row.x + 3, row.y)
  // Clicking a session opens it with typing in its reply editor.
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  expect(view.renderer.currentFocusedEditor).not.toBeNull()
  await leaveComposer(view)
  expect(detail.focused).toBe(true)
  view.mockInput.pressKey("?")
  await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  expect(detail.focused).toBe(true)
  view.mockInput.pressTab()
  expect(list.focused).toBe(true)
})

test("clicking draft labels and non-field space leaves its editor ready for typing", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 80, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  // The narrow terminal starts typing, so Esc frees the shortcut keys first.
  await leaveComposer(view)
  for (const [key, caption] of [
    ["n", "What would you like to do?"],
    ["f", "Message…"],
  ]) {
    view.mockInput.pressKey(key!)
    if (key === "f") await waitForFrame(view, (frame) => frame.includes(caption!))
    await clickText(view, caption!)
    const editor = descendants(view.renderer.root).find((node) => node instanceof TextareaRenderable)!
    expect(editor.focused).toBe(true)
    await view.mockInput.typeText("Still typing in the draft")
    expect(editor.plainText).toBe("Still typing in the draft")
    await view.renderOnce()
    if (key === "n") await view.mockMouse.click(editor.x + 2, editor.y + editor.height)
    if (key === "f") await clickText(view, "Enter send")
    expect(editor.focused).toBe(true)
    await view.mockInput.typeText(" after clicking")
    expect(editor.plainText).toBe("Still typing in the draft after clicking")
    view.mockInput.pressKey("F4")
  }
  expect(server.posts).toHaveLength(0)
})

test("long paths cannot displace header actions or footer shortcuts at supported sizes", async () => {
  const server = fixture({ directory: "/srv/projects/terminal-workbench/packages/runtime" })
  const view = await createTestRenderer({ width: 160, height: 48 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  for (const [width, height] of [
    [160, 48],
    [60, 24],
  ]) {
    view.resize(width!, height!)
    await view.renderOnce()
    const frame = view.captureCharFrame()
    // Below 70 columns the buttons give way to the run state; their keys stay in help and the palette.
    expect(frame.includes("Sessions Ctrl+K")).toBe(width! >= 70)
    expect(frame.includes("Models m")).toBe(width! >= 70)
    // The palette stays in the footer on wide screens; a narrow footer keeps to the next action and help.
    expect(frame).toContain(width! < 90 ? "? help" : "Ctrl+P commands")
  }
  view.mockInput.pressKey("n")
  await view.renderOnce()
  // At 60 columns the buttons are gone whichever dialog is open.
  expect(view.captureCharFrame()).not.toContain("Models")
  expect(view.captureCharFrame()).not.toContain("Sessions Ctrl+K")
})

test("activity animation pauses behind the resize shield, supports reduced motion, and stops when idle", async () => {
  const options = { active: true }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 80, height: 28 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => /Working \(Esc Esc to stop\) [\u2800-\u28ff]{3}/.test(frame))
  const bar = descendants(view.renderer.root).find(
    (node) => node instanceof TextRenderable && /^Working \(Esc Esc to stop\) [\u2800-\u28ff]{3}$/.test(node.plainText),
  ) as TextRenderable
  const first = bar.plainText
  await Bun.sleep(250)
  expect(bar.plainText).not.toBe(first)
  view.resize(59, 23)
  await view.renderOnce()
  const hidden = bar.plainText
  expect(bar.visible).toBe(false)
  await Bun.sleep(200)
  expect(bar.plainText).toBe(hidden)
  view.resize(80, 28)
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Toggle reduced motion")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reduced motion on"))
  const reduced = bar.plainText
  await Bun.sleep(200)
  expect(bar.plainText).toBe(reduced)
  options.active = false
  await app.refresh()
  expect(bar.visible).toBe(false)
  expect(bar.plainText).toBe("")
})

test("runTui closes a connection whose dashboard fails to mount, reports it, and tears down on exit", async () => {
  // Isolate startup mocks so the real renderer/HTTP integration tests above
  // keep their module bindings. Only the terminal boundary is substituted.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { mock } from "bun:test"
    import { createTestRenderer } from "@opentui/core/testing"
    const core = await import("@opentui/core")
    const server = await import("./src/server")
    const connect = server.connect
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ healthy: true }) })
    const view = await createTestRenderer({ width: 80, height: 24 })
    let created = 0
    let closed = 0
    let destroyed = false
    view.renderer.once("destroy", () => { destroyed = true })
    // The server picker mounts first; fail the dashboard that follows it.
    const add = view.renderer.root.add.bind(view.renderer.root)
    let adds = 0
    view.renderer.root.add = (...args) => {
      if (++adds === 2) throw new Error("mount failure")
      return add(...args)
    }
    Object.defineProperty(process.stdin, "isTTY", { value: true })
    Object.defineProperty(process.stdout, "isTTY", { value: true })
    mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => view.renderer }))
    mock.module("./src/server", () => ({ ...server, connect: (options) => {
      created++
      const connection = connect(options)
      const close = connection.close
      return { ...connection, close: () => { closed++; close() } }
    } }))
    const { runTui } = await import("./src/index")
    const running = runTui({ url: upstream.url.origin })
    for (let attempt = 0; closed === 0 && attempt < 200; attempt++) await Bun.sleep(25)
    await view.renderOnce()
    const reported = view.captureCharFrame().includes("mount failure")
    view.renderer.destroy()
    await running
    upstream.stop(true)
    if (!reported || created !== 1 || closed !== 1 || !destroyed) throw new Error("Startup cleanup failed")
    console.log("cleanup verified")
  `,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, XDG_CONFIG_HOME: "/nonexistent-turen-tui-config" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, error }).toEqual({ code: 0, error: "" })
  expect(output).toContain("cleanup verified")
})
