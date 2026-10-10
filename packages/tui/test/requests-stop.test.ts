import { afterEach, expect, test } from "bun:test"
import { Forge } from "@turenlabs/client"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createRequests } from "../src/requests"
import { createSlashCommands } from "../src/slash"
import { createMentions } from "../src/mentions"
import { connect } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

async function fixture(running = false, status = 204) {
  const calls: { method: string; path: string }[] = []
  const notices: string[] = []
  const connection = connect({ url: "http://127.0.0.1:1" })
  cleanup.push(connection.close)
  // Exercise the generated client without opening a listener or replacing global fetch.
  connection.client = Forge.make({
    baseUrl: connection.address,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const address = input instanceof Request ? input.url : input.toString()
        calls.push({ method: init?.method ?? "GET", path: new URL(address).pathname })
        if (status === 204) return new Response(null, { status })
        return Response.json(
          {
            _tag: status === 409 ? "ConflictError" : "ServiceUnavailableError",
            message: `Task cancellation failed (${status}).`,
            resource: "ses_parent",
            service: "session.interrupt",
          },
          { status },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.selected = "ses_parent"
  state.snapshot = {
    location: { directory: "/synthetic", project: { id: "project", directory: "/synthetic" } },
    sessions: [],
    active: running ? { ses_parent: { type: "running" } } : {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    terminalFolderErrors: [],
    updated: 1,
    more: false,
  }
  const ui = createLayout(view.renderer, state)
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition() {},
    cancelPosition() {},
    changed() {
      ui.resize()
    },
    async submitted() {},
    say() {},
  })
  const requests = createRequests(
    view.renderer,
    state,
    connection,
    dialogs,
    (message) => notices.push(message),
    () => {},
    createSlashCommands(
      view.renderer,
      state,
      connection,
      () => [],
      () => {},
    ),
    createMentions(view.renderer, state, connection),
  )
  return { view, state, dialogs, requests, calls, notices }
}

for (const running of [false, true]) {
  test(`kill delegates the whole task tree once, with ${running ? "running" : "idle"} parent and captured recipient`, async () => {
    const f = await fixture(running)
    f.requests.kill()
    await f.view.renderOnce()
    expect(f.view.captureCharFrame()).toContain("unfinished subagent tasks")
    await f.dialogs.submit()
    expect(f.calls).toEqual([])
    await f.view.mockInput.typeText("kill")
    f.state.selected = "ses_other"
    await f.dialogs.submit()
    expect(f.calls).toEqual([{ method: "POST", path: "/api/session/ses_parent/interrupt" }])
    expect(f.state.modal).toBeUndefined()
    expect(f.notices).toEqual(["Session killed."])
  })
}

for (const status of [409, 503]) {
  test(`kill keeps the confirmation open when server task cancellation returns ${status}`, async () => {
    const f = await fixture(false, status)
    f.requests.kill()
    await f.view.renderOnce()
    await f.view.mockInput.typeText("kill")
    await f.dialogs.submit()
    expect(f.calls).toEqual([{ method: "POST", path: "/api/session/ses_parent/interrupt" }])
    expect(f.notices).toEqual([])
    expect(f.state.modal?.busy).toBe(false)
    expect(f.state.modal?.error.plainText).toContain(`Task cancellation failed (${status}).`)
  })
}

test("instant stop still needs a running parent and sends no task inventory requests", async () => {
  const f = await fixture()
  expect(f.requests.stopRunning()).toBe(false)
  expect(f.calls).toEqual([])
  f.state.snapshot!.active = { ses_parent: { type: "running" } }
  expect(f.requests.stopRunning()).toBe(true)
  await Bun.sleep(20)
  expect(f.calls).toEqual([{ method: "POST", path: "/api/session/ses_parent/interrupt" }])
  // The outcome waits for the update that shows the session idle; said earlier, that update would erase it.
  expect(f.notices).toEqual([])
  f.state.snapshot!.active = {}
  await Bun.sleep(250)
  expect(f.notices).toEqual(["Session interrupted."])
})
