import { expect, test } from "bun:test"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createDashboardState } from "../src/state"
import { terminal } from "./support"

for (const dispose of [false, true])
  test(`post-submit navigation waits for refresh and respects disposal (${dispose})`, async () => {
    const { view } = await terminal()
    const state = createDashboardState()
    const ui = createLayout(view.renderer, state)
    view.renderer.root.add(ui.root)
    const entered = Promise.withResolvers<void>()
    const refresh = Promise.withResolvers<void>()
    const dialogs = createDialogs(view.renderer, state, ui, {
      changed: () => {},
      say: () => {},
      cancelPosition: () => {},
      rememberPosition: () => {},
      submitted: async () => {
        entered.resolve()
        await refresh.promise
      },
    })
    let reopened = 0
    const dialog = dialogs.open("New personal wing")!
    dialog.submit = async () => {}
    dialog.afterSubmit = () => {
      reopened++
    }
    const pending = dialogs.submit()
    await entered.promise
    expect(state.modal).toBeUndefined()
    expect(reopened).toBe(0)
    if (dispose) {
      state.closed = true
      view.renderer.destroy()
    }
    refresh.resolve()
    await pending
    expect(reopened).toBe(dispose ? 0 : 1)
  })
