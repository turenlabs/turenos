import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/dashboard/mount"
import { connect } from "../src/server"
import { cleanup, sized, terminal, turen } from "./support"

const HINT = "Click, Esc or Ctrl+H to return"
/** The anvil is drawn in Braille dots. */
const ANVIL = /[\u2801-\u28ff]/

test("Ctrl+H, sent as 0x08 as tmux sends it, hides the screen behind the anvil until a click", async () => {
  const { view, screen } = await sized(100, 30)
  await screen("main says hello")
  view.mockInput.pressKey("h", { ctrl: true })
  const hidden = await screen(HINT)
  expect(hidden).toMatch(ANVIL)
  expect(hidden).not.toContain("main says hello")
  // Keys that would open a dialog go nowhere while the screen is hidden.
  view.mockInput.pressKey("n")
  view.mockInput.pressEnter()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain(HINT)
  await view.mockMouse.click(50, 15)
  const back = await screen("main says hello")
  expect(back).not.toContain(HINT)
  expect(back).not.toContain("What would you like to do?")
})

test("the screensaver keeps the editor's draft and focus, and Esc brings the screen back", async () => {
  const server = turen({ routes: { "GET /api/session": () => ({ data: [], cursor: {} }) } })
  const view = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  view.mockInput.pressKey("n", { ctrl: true })
  await waitFor(view, "What would you like to do?")
  const editor = view.renderer.currentFocusedEditor!
  await view.mockInput.typeText("draft")
  view.mockInput.pressKey("h", { ctrl: true })
  await waitFor(view, HINT)
  await view.mockInput.typeText("xyz")
  await view.mockInput.pasteBracketedText("pasted")
  view.mockInput.pressEscape()
  const back = await waitFor(view, "What would you like to do?")
  expect(back).not.toContain(HINT)
  expect(view.renderer.currentFocusedEditor).toBe(editor)
  expect(editor.plainText).toBe("draft")
})

test("with reduced motion the screensaver's anvil stands still, and otherwise it turns", async () => {
  const { view, screen, palette } = await sized(100, 30)
  await screen("main says hello")
  const frames = async () => {
    view.mockInput.pressKey("h", { ctrl: true })
    const first = await screen(HINT)
    await Bun.sleep(400)
    await view.renderOnce()
    const second = view.captureCharFrame()
    view.mockInput.pressEscape()
    await screen("main says hello")
    return [first, second]
  }
  const [turning, turned] = await frames()
  expect(turned).not.toBe(turning)
  await palette("Toggle reduced motion")
  await screen("Reduced motion on.")
  const [still, after] = await frames()
  expect(still).toMatch(ANVIL)
  expect(after).toBe(still)
})

test("the welcome opens under the wordmark and the anvil, which leave a short pane to the welcome text", async () => {
  const server = turen({ routes: { "GET /api/session": () => ({ data: [], cursor: {} }) } })
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("No session selected")
  await view.renderOnce()
  expect(view.captureCharFrame()).toMatch(ANVIL)
  view.resize(80, 24)
  await view.renderOnce()
  await view.renderOnce()
  const short = view.captureCharFrame()
  expect(short).toContain("No session selected")
  expect(short).not.toMatch(ANVIL)
})

async function waitFor(view: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await view.renderOnce()
    if (view.captureCharFrame().includes(text)) return view.captureCharFrame()
    await Bun.sleep(20)
  }
  throw new Error(`Expected ${JSON.stringify(text)}:\n${view.captureCharFrame()}`)
}
