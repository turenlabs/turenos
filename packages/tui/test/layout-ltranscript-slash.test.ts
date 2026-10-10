import { afterEach, expect, test } from "bun:test"
import type { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { describe } from "../src/slash/commands"
import { createSlashCommands } from "../src/slash"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

const item = {
  name: "customize-forge",
  description: "Skill · Instructions for configuring and extending Forge",
  local: false,
}

test("a command row is cut at a word with an ellipsis, and the description goes when little of it fits", () => {
  expect(describe(item)).toBe("/customize-forge - Skill · Instructions for configuring and extending Forge")
  expect(describe(item, 60)).toBe("/customize-forge - Skill · Instructions for configuring and…")
  expect(describe(item, 60).length).toBeLessThanOrEqual(60)
  expect(describe(item, 26)).toBe("/customize-forge")
  expect(describe({ name: "help", local: true })).toBe("/help")
})

for (const [width, height] of [
  [60, 24],
  [80, 24],
  [100, 30],
] as const) {
  test(`slash rows never end mid-word at ${width}x${height}`, async () => {
    const view = await createTestRenderer({ width, height })
    cleanup.push(() => view.renderer.destroy())
    const state = createDashboardState()
    const dialogs = createDialogs(view.renderer, state, createLayout(view.renderer, state), {
      rememberPosition() {},
      cancelPosition() {},
      changed() {},
      async submitted() {},
      say() {},
    })
    const dialog = dialogs.open("Reply", false, 24, true)!
    const editor = dialogs.prompt(dialog, "Your message")
    createSlashCommands(
      view.renderer,
      state,
      { commands: async () => [{ name: item.name, description: item.description }] },
      () => [],
      () => {},
      dialogs.resize,
    ).attach(dialog, editor, () => ({ directory: "/project" }))
    editor.focus()
    await view.renderOnce()
    editor.setText("/cu")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await view.renderOnce()
    const list = dialog.form.getChildren().find((child) => child.id === `${editor.id}-slash`) as TextRenderable
    const row = list.plainText.split("\n")[0]!
    expect(row.length).toBeLessThanOrEqual(editor.width)
    expect(row).toMatch(/^▶ \/customize-forge( - .*[^\s]…)?$/)
  })
}

test("an open slash list is fitted again when the terminal narrows", async () => {
  const view = await createTestRenderer({ width: 160, height: 40 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  const ui = createLayout(view.renderer, state)
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition() {},
    cancelPosition() {},
    changed() {},
    async submitted() {},
    say() {},
  })
  const dialog = dialogs.open("Reply", false, 24, true)!
  const editor = dialogs.prompt(dialog, "Your message")
  createSlashCommands(
    view.renderer,
    state,
    { commands: async () => [{ name: item.name, description: item.description }] },
    () => [],
    () => {},
    dialogs.resize,
  ).attach(dialog, editor, () => ({ directory: "/project" }))
  editor.focus()
  await view.renderOnce()
  editor.setText("/cu")
  await new Promise((resolve) => setTimeout(resolve, 0))
  await view.renderOnce()
  const list = dialog.form.getChildren().find((child) => child.id === `${editor.id}-slash`) as TextRenderable
  const wide = list.plainText.length
  view.resize(60, 24)
  ui.resize()
  await view.renderOnce()
  await view.renderOnce()
  expect(list.plainText.length).toBeLessThan(wide)
  expect(list.plainText.length).toBeLessThanOrEqual(editor.width)
})
