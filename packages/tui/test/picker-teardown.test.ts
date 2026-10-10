import { expect, test } from "bun:test"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { openSection } from "../src/picker"
import { createDashboardState } from "../src/state"
import { terminal } from "./support"

for (const fails of [false, true])
  test(`picker completion ignores destroyed renderables (${fails})`, async () => {
    const { view } = await terminal()
    const state = createDashboardState()
    const ui = createLayout(view.renderer, state)
    view.renderer.root.add(ui.root)
    const dialogs = createDialogs(view.renderer, state, ui, {
      changed: () => {},
      say: () => {},
      cancelPosition: () => {},
      rememberPosition: () => {},
      submitted: async () => {},
    })
    const pending = Promise.withResolvers<string>()
    const fills: string[] = []
    const result = openSection(
      view.renderer,
      dialogs,
      state,
      { title: "Test picker" },
      () => pending.promise,
      (value, picker) => {
        fills.push(value)
        picker.text.content = value
      },
    )
    expect(state.modal).toBeDefined()
    view.renderer.destroy()
    if (fails) pending.reject(new Error("Request stopped"))
    if (!fails) pending.resolve("Loaded")
    await expect(result).resolves.toBeUndefined()
    expect(fills).toEqual([])
  })
