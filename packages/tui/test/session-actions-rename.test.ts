import { expect, test } from "bun:test"
import { until } from "./support"
import { fixture } from "./session-actions-fixture"

test("rename seeds the title, displays the exact recipient and does not retarget after selection changes", async () => {
  const app = await fixture()
  expect(app.actions.rename()).toBeUndefined()
  expect(app.input().value).toBe("Original title")
  expect(await app.screen("Rename session")).toContain("ses_root")
  expect(app.view.captureCharFrame()).toContain("/srv/original project")
  app.state.selected = "ses_child"
  app.input().value = "New title"
  app.view.mockInput.pressEnter()
  await app.wait(() => !app.state.modal)
  expect(app.calls.filter((call) => call.method === "PATCH")).toEqual([
    { path: "/session/ses_root", method: "PATCH", directory: "/srv/original project", body: { title: "New title" } },
  ])
  expect(app.opened).toEqual([{ id: "ses_root", inspect: false, session: app.sessions.get("ses_root") }])
  expect(app.state.inspected?.title).toBe("New title")
  expect(app.state.snapshot?.sessions.find((s) => s.id === "ses_root")?.title).toBe("New title")
})

test("rename Ctrl+S submits and empty titles fail without leaving the form or sending", async () => {
  const app = await fixture()
  app.actions.rename()
  app.input().value = "   "
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("Enter a title between 1 and 200")
  expect(app.calls).toEqual([])
  expect(app.state.modal?.busy).toBe(false)
  app.input().value = "Saved title"
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]?.session?.title).toBe("Saved title")
})

test("archive requires explicit typed confirmation, retries a stable timestamp, unpins and never interrupts", async () => {
  const app = await fixture({ failOnce: true })
  app.state.inspected = app.sessions.get("ses_root")
  app.state.inspection = "ses_root"
  app.state.query = "ses_root"
  app.actions.archive()
  expect(await app.screen("Archive session")).toContain("does not interrupt")
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  await app.dialogs.submit()
  await app.screen("Type archive to confirm.")
  expect(app.calls).toEqual([])
  app.input().value = "archive"
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  await app.dialogs.submit()
  await app.screen("Server returned HTTP 502")
  const first = app.calls.find((call) => call.method === "PATCH")!.body
  await Bun.sleep(5)
  await app.dialogs.submit()
  expect(app.calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([first, first])
  expect(app.calls.some((call) => call.path.includes("interrupt"))).toBe(false)
  expect(app.state.inspected).toBeUndefined()
  expect(app.state.inspection).toBe("")
  expect(app.state.query).toBe("")
  expect(app.state.snapshot?.sessions.some((s) => s.id === "ses_root")).toBe(false)
  expect(app.opened).toEqual([])
  expect(app.notices).toContain("Session archived. Running work was not interrupted.")
})

test("archived zero offers restore and sends explicit null before reopening a fresh session", async () => {
  const app = await fixture({ archived: 0 })
  app.actions.archive()
  expect(await app.screen("Restore session")).not.toContain("Archiving hides")
  app.input().value = "restore"
  // Enter sends once the word is typed, like Ctrl+S.
  app.view.mockInput.pressEnter()
  await until(() => app.calls.some((call) => call.method === "PATCH"))
  expect(app.calls.find((call) => call.method === "PATCH")?.body).toEqual({ time: { archived: null } })
  expect(app.opened).toEqual([{ id: "ses_root", inspect: false, session: app.sessions.get("ses_root") }])
  expect(app.state.inspected?.time.archived).toBeUndefined()
})

test("task-owned mutation rejection stays visible without changing selection or claiming success", async () => {
  const app = await fixture({ patchStatus: 409 })
  app.actions.archive()
  expect(await app.screen("Archive session")).toContain("Task-owned sessions may reject")
  app.input().value = "archive"
  await app.dialogs.submit()
  const frame = await app.screen("Server returned HTTP 409")
  expect(frame).not.toContain("private server diagnostic")
  expect(app.state.selected).toBe("ses_root")
  expect(app.opened).toEqual([])
  expect(app.state.modal?.busy).toBe(false)
})
