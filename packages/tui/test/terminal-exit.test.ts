import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { closedLine, settleTerminalInput } from "../src/terminal-exit"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

test("exit settling absorbs input without editing and removes its listeners afterward", async () => {
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const input = new EventEmitter()
  const editor = new TextareaRenderable(view.renderer, { width: 40, height: 3 })
  view.renderer.root.add(editor)
  editor.focus()
  let settled = false
  const waiting = settleTerminalInput(view.renderer, input).then(() => {
    settled = true
  })
  expect(view.renderer.useMouse).toBe(false)
  await view.mockInput.typeText("do not enter this")
  await view.mockInput.pasteBracketedText("do not paste this")
  expect(editor.plainText).toBe("")
  await Bun.sleep(80)
  input.emit("data", Buffer.from("\x1b[4;480;800t"))
  await Bun.sleep(80)
  expect(settled).toBe(false)
  await waiting
  expect(input.listenerCount("data")).toBe(0)
  await view.mockInput.typeText("after")
  expect(editor.plainText).toBe("after")
})

test("noisy input cannot hold exit indefinitely, and renderer destruction ends settling", async () => {
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const input = new EventEmitter()
  const noise = setInterval(() => input.emit("data", Buffer.from("\x1b]11;rgb:0/0/0\x07")), 30)
  cleanup.push(() => clearInterval(noise))
  const start = Date.now()
  await settleTerminalInput(view.renderer, input)
  expect(Date.now() - start).toBeLessThan(2000)
  expect(input.listenerCount("data")).toBe(0)
  clearInterval(noise)
  const waiting = settleTerminalInput(view.renderer, input)
  view.renderer.destroy()
  await waiting
  expect(input.listenerCount("data")).toBe(0)
  await settleTerminalInput(view.renderer, input)
  expect(input.listenerCount("data")).toBe(0)
})

test("the closing line says the TUI quit and counts discarded drafts only when there are some", () => {
  expect(closedLine(0)).toBe("Turen TUI closed.\n")
  expect(closedLine(1)).toBe("Turen TUI closed. 1 unsent draft discarded.\n")
  expect(closedLine(3)).toBe("Turen TUI closed. 3 unsent drafts discarded.\n")
})
