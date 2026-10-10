import { expect, test } from "bun:test"
import { fixture, session } from "./session-actions-fixture"

test("tasks deduplicate active records, show failures and keep search typing focus through keyboard navigation", async () => {
  const app = await fixture()
  app.actions.tasks()
  const frame = await app.screen("[running] Review code")
  expect(frame).toContain("Recent and active subagent tasks")
  expect(frame).toContain("[failed] Nested checks")
  expect(frame).toContain("Failure: Permission denied")
  expect(frame).toContain("1/2")
  expect(frame).not.toContain("[starting]")
  expect(frame).not.toContain("\u001b")
  expect(app.state.modal?.fields).toHaveLength(1)
  const query = app.input()
  app.view.mockInput.pressTab()
  app.view.mockInput.pressArrow("down")
  expect(query.focused).toBe(true)
  await app.view.mockInput.typeText("j")
  expect(query.value).toBe("j")
  await app.screen("No matching loaded tasks")
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  query.value = "failed"
  query.emit("input")
  await app.screen("1/1")
  app.view.mockInput.pressEnter()
  await app.wait(() => app.opened.length === 1)
  expect(app.calls[0]?.path).toBe("/api/session/ses_nested")
  expect(app.opened[0]).toEqual({ id: "ses_nested", inspect: false, session: app.sessions.get("ses_nested") })
})

test("task mouse navigation uses the clicked child and search survives whitespace clicks and minimum-size resize", async () => {
  const app = await fixture()
  app.actions.tasks()
  app.view.resize(60, 24)
  await app.screen("Nested checks")
  const query = app.input()
  const form = app.state.modal!.form
  await app.view.mockMouse.click(form.x + 1, form.y + form.height - 1)
  expect(query.focused).toBe(true)
  app.view.resize(59, 23)
  await app.view.renderOnce()
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  app.view.resize(60, 24)
  await app.screen("Nested checks")
  const lines = app.view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Nested checks"))
  await app.view.mockMouse.click(lines[y]!.indexOf("Nested checks") + 1, y)
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]?.id).toBe("ses_nested")
})

test("parent and child navigation reject substituted sessions and preserve the current selection", async () => {
  for (const action of ["parent", "tasks"] as const) {
    const app = await fixture({ wrongID: true })
    app.actions[action]()
    if (action === "tasks") app.view.mockInput.pressEnter()
    await app.screen("Invalid server response (session identity)")
    expect(app.opened).toEqual([])
    expect(app.state.selected).toBe("ses_root")
    expect(app.calls[0]?.path).toBe(action === "parent" ? "/api/session/ses_parent" : "/api/session/ses_child")
  }
})

test("parent opens the captured parent ID and malformed IDs never reach the server", async () => {
  const app = await fixture()
  expect(app.actions.parent()).toBeUndefined()
  app.state.selected = "ses_child"
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]).toEqual({ id: "ses_parent", inspect: false, session: app.sessions.get("ses_parent") })
  await app.wait(() => app.calls.some((call) => call.path === "/api/pty"))
  app.state.selected = "ses_root"
  app.state.snapshot!.sessions = [{ ...session(), parentID: "../bad" }]
  const count = app.calls.length
  app.actions.parent()
  await app.screen("Invalid server response (identifier)")
  expect(app.calls).toHaveLength(count)
})

test("busy mutations block edits, closing and duplicate sends", async () => {
  const held = Promise.withResolvers<void>()
  const app = await fixture({ hold: held.promise })
  app.actions.rename()
  app.input().value = "Held title"
  app.view.mockInput.pressEnter()
  await app.wait(() => app.calls.length === 1)
  app.view.mockInput.pressEscape()
  app.view.mockInput.pressEnter()
  await app.view.mockInput.typeText("changed")
  expect(app.state.modal?.busy).toBe(true)
  expect(app.input().value).toBe("Held title")
  held.resolve()
  await app.wait(() => !app.state.modal)
  expect(app.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
})

test("task paging keeps search focus and rejects malformed child IDs before GET", async () => {
  const app = await fixture()
  const detail = app.state.detail!
  detail.tasks = {
    data: Array.from({ length: 20 }, (_, i) => ({
      ...detail.tasks.data[0]!,
      id: `tsk_${i}`,
      childSessionID: i === 0 ? "../bad" : "ses_child",
      description: `Task number ${i}`,
    })),
    active: [],
    cursor: {},
  }
  app.actions.tasks()
  app.view.resize(60, 24)
  await app.screen("Task number 0")
  app.view.mockInput.pressKey("\x1b[6~")
  await app.view.renderOnce()
  expect(app.input().focused).toBe(true)
  expect(app.state.modal!.form.scrollTop).toBeGreaterThan(0)
  app.input().value = "tsk_0"
  app.input().emit("input")
  await app.screen("1/1")
  app.view.mockInput.pressEnter()
  await app.screen("Invalid server response (identifier)")
  expect(app.calls).toEqual([])
})

test("unavailable session, stale tasks and offline navigation do not send requests", async () => {
  const app = await fixture()
  app.state.selected = "ses_missing"
  app.actions.rename()
  expect(app.notices.at(-1)).toBe("Select an available session first.")
  app.state.selected = "ses_child"
  app.actions.parent()
  expect(app.notices.at(-1)).toBe("This session has no parent session.")
  app.actions.tasks()
  expect(app.notices.at(-1)).toContain("Refresh this session's details")
  app.state.selected = "ses_root"
  app.state.connected = false
  app.actions.parent()
  await app.screen("Reconnect before opening a session.")
  expect(app.calls).toEqual([])
})
