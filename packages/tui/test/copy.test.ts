import { afterEach, expect, spyOn, test } from "bun:test"
import { KeyEvent, MouseEvent, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createCopyControls } from "../src/copy"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { display } from "../src/messages"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

function key(name: string, modifiers: Partial<KeyEvent> = {}) {
  return new KeyEvent({
    name,
    sequence: name,
    raw: name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "press",
    source: "raw",
    ...modifiers,
  })
}

async function fixture(content = "Selected transcript text", width = 80, height = 24) {
  const view = await createTestRenderer({ width, height, useMouse: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  const messages: string[] = []
  const controls = createCopyControls(view.renderer, state, (message) => messages.push(message))
  const clipboard = spyOn(view.renderer, "copyToClipboardOSC52").mockReturnValue(true)
  cleanup.push(() => clipboard.mockRestore())
  const text = new TextRenderable(view.renderer, {
    content,
    width: "100%",
    height: "100%",
    selectable: true,
    onMouseDown: controls.rightClick,
  })
  view.renderer.root.add(text)
  view.renderer.keyInput.on("keypress", (event) => {
    if (controls.key(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
  })
  await view.renderOnce()
  return { ...view, state, text, controls, clipboard, messages }
}

test("drag does not copy; Ctrl+Y and right-click attempt copy and retain actual selection", async () => {
  const f = await fixture()
  await f.mockMouse.drag(0, 0, 8, 0)
  const selected = f.renderer.getSelection()?.getSelectedText()
  expect(selected).toBeTruthy()
  expect(f.clipboard).not.toHaveBeenCalled()
  f.renderer.keyInput.emit("keypress", key("y", { ctrl: true }))
  expect(f.clipboard).toHaveBeenCalledWith(display(selected!))
  expect(f.messages.at(-1)).toContain("attempted (not confirmed)")
  expect(f.messages.at(-1)).toContain("F6")
  expect(f.renderer.getSelection()?.getSelectedText()).toBe(selected)
  await f.mockMouse.click(2, 0, 2)
  expect(f.clipboard).toHaveBeenCalledTimes(2)
  expect(f.renderer.getSelection()?.getSelectedText()).toBe(selected)
  await f.renderOnce()
  expect(f.clipboard).toHaveBeenCalledTimes(2)
})

test("dashboard empty copy explains native fallback and only right mouse down is intercepted", async () => {
  const f = await fixture()
  expect(f.controls.key(key("y", { ctrl: true }))).toBe(true)
  expect(f.messages.at(-1)).toContain("Select text")
  for (const [type, button] of [
    ["down", 0],
    ["down", 1],
    ["up", 2],
    ["drag", 2],
    ["down", 2],
  ] as const) {
    const event = new MouseEvent(f.text, {
      type,
      button,
      x: 0,
      y: 0,
      modifiers: { ctrl: false, alt: false, shift: false },
    })
    f.controls.rightClick(event)
    expect(event.defaultPrevented).toBe(type === "down" && button === 2)
    expect(event.propagationStopped).toBe(type === "down" && button === 2)
  }
  expect(f.messages.at(-1)).toContain("F6 restores mouse")
  expect(f.clipboard).not.toHaveBeenCalled()
})

test("shortcuts require exact modifiers and keyboard F6 restores mouse while disabled", async () => {
  const f = await fixture()
  for (const modifier of ["ctrl", "shift", "meta", "option", "super", "hyper"] as const) {
    expect(f.controls.key(key("f6", { [modifier]: true }))).toBe(false)
    if (modifier !== "ctrl") expect(f.controls.key(key("y", { ctrl: true, [modifier]: true }))).toBe(false)
  }
  expect(f.controls.key(key("y"))).toBe(false)
  expect(f.controls.key(key("f6", { eventType: "release" }))).toBe(false)
  expect(f.controls.key(key("y", { ctrl: true, eventType: "release" }))).toBe(false)
  f.renderer.keyInput.emit("keypress", key("f6"))
  expect(f.renderer.useMouse).toBe(false)
  expect(f.messages.at(-1)).toContain("F6 restores mouse")
  f.renderer.keyInput.emit("keypress", key("f6"))
  expect(f.renderer.useMouse).toBe(true)
  expect(f.clipboard).not.toHaveBeenCalled()
})

test("modal empty Ctrl+Y remains available to editor and F6 remains global", async () => {
  const f = await fixture()
  f.text.destroy()
  const ui = createLayout(f.renderer, f.state)
  const dialogs = createDialogs(f.renderer, f.state, ui, {
    rememberPosition() {},
    cancelPosition() {},
    changed() {},
    async submitted() {},
    say() {},
  })
  dialogs.open("Compose")
  expect(f.state.modal).toBeDefined()
  expect(f.controls.key(key("y", { ctrl: true }))).toBe(false)
  expect(f.messages).toEqual([])
  expect(f.controls.key(key("f6"))).toBe(true)
  expect(f.controls.key(key("f6"))).toBe(true)
  expect(f.renderer.useMouse).toBe(true)
  expect(f.clipboard).not.toHaveBeenCalled()
  const text = f.state.modal!.error
  text.content = "Selected modal text"
  text.selectable = true
  await f.renderOnce()
  f.renderer.startSelection(text, text.x, text.y)
  f.renderer.updateSelection(text, text.x + 8, text.y, { finishDragging: true })
  const selected = f.renderer.getSelection()?.getSelectedText()
  expect(selected).toBeTruthy()
  expect(f.controls.key(key("y", { ctrl: true }))).toBe(true)
  expect(f.clipboard).toHaveBeenCalledWith(display(selected!))
})

test.each(["false", "throw"])("clipboard %s reports fallback without clearing selection", async (failure) => {
  const f = await fixture()
  await f.mockMouse.drag(0, 0, 8, 0)
  const selected = f.renderer.getSelection()?.getSelectedText()
  expect(selected).toBeTruthy()
  f.clipboard.mockImplementation(() => {
    if (failure === "throw") throw new Error("Terminal rejected copy")
    return false
  })
  f.controls.copySelection()
  expect(f.messages.at(-1)).toContain("unavailable")
  expect(f.messages.at(-1)).toContain("F6")
  expect(f.renderer.getSelection()?.getSelectedText()).toBe(selected)
})

test("copy bounds and sanitizes real selected text through display", async () => {
  const f = await fixture("Authored\u001b[31m text\u0007\n" + "x".repeat(18000), 200, 100)
  f.renderer.startSelection(f.text, 0, 0)
  f.renderer.updateSelection(f.text, 199, 99, { finishDragging: true })
  const selected = f.renderer.getSelection()?.getSelectedText()
  expect(selected!.length).toBeGreaterThan(16000)
  f.controls.copySelection()
  expect(f.clipboard).toHaveBeenCalledWith(display(selected!))
  const copied = f.clipboard.mock.calls[0]![0]
  expect(copied).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  expect(copied).toEndWith("[display shortened]")
  expect(copied.length).toBeLessThan(16030)
})
