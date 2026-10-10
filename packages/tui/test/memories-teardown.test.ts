import { expect, test } from "bun:test"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { browse } from "../src/memories/browse"
import { connect } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup, terminal, turen } from "./support"

for (const fails of [false, true])
  test(`memory list completion ignores a disposed dashboard (${fails})`, async () => {
    const { view } = await terminal()
    const state = createDashboardState()
    const ui = createLayout(view.renderer, state)
    view.renderer.root.add(ui.root)
    const connection = connect({ url: turen().url })
    cleanup.push(() => connection.close())
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof connection.client.memories.list>>>()
    const dialogs = createDialogs(view.renderer, state, ui, {
      changed: () => {},
      say: () => {},
      cancelPosition: () => {},
      rememberPosition: () => {},
      submitted: async () => {},
    })
    browse(
      {
        renderer: view.renderer,
        state,
        dialogs,
        connection: {
          ...connection,
          client: { ...connection.client, memories: { ...connection.client.memories, list: () => pending.promise } },
        },
        say: () => {},
        root: "Memories",
      },
      { wingID: "wng_1", name: "Personal" },
      () => {},
    )
    expect(state.modal).toBeDefined()
    state.closed = true
    view.renderer.destroy()
    if (fails) pending.reject(new Error("Request stopped"))
    if (!fails) pending.resolve([])
    await pending.promise.catch(() => {})
    await Bun.sleep(0)
    expect(view.renderer.isDestroyed).toBe(true)
  })
