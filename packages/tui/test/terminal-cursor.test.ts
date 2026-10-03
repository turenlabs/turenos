import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createLayout } from "../src/layout"
import { createDashboardState } from "../src/state"
import { createDialogs } from "../src/dialogs"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

test("terminal cursor starts hidden and responds correctly to search focus and blur", async () => {
  const view = await createTestRenderer({ width: 80, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  const layout = createLayout(view.renderer, state)
  view.renderer.root.add(layout.root)
  await view.renderOnce()

  // Terminal cursor is hidden on startup
  expect(view.renderer.getCursorState().visible).toBe(false)

  // Focus search input
  layout.search.visible = true
  state.searching = { query: "", selected: "" }
  layout.search.focus()
  await view.renderOnce()
  expect(view.renderer.getCursorState().visible).toBe(true)

  // Close search input and return focus to main UI
  state.searching = undefined
  layout.search.visible = false
  layout.focus()
  await view.renderOnce()
  expect(view.renderer.getCursorState().visible).toBe(false)
})

test("terminal cursor is visible in modal text inputs and hidden when modal is closed", async () => {
  const view = await createTestRenderer({ width: 80, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  const layout = createLayout(view.renderer, state)
  view.renderer.root.add(layout.root)
  const dialogs = createDialogs(view.renderer, state, layout, {
    changed: () => layout.focus(),
    say: () => {},
    cancelPosition: () => {},
    rememberPosition: () => {},
    submitted: async () => {},
  })
  await view.renderOnce()
  expect(view.renderer.getCursorState().visible).toBe(false)

  const dialog = dialogs.open("New session")!
  const inputField = dialogs.input(dialog, "Directory", "/tmp")
  inputField.focus()
  await view.renderOnce()
  expect(view.renderer.getCursorState().visible).toBe(true)

  dialogs.close()
  await view.renderOnce()
  expect(view.renderer.getCursorState().visible).toBe(false)
})
