import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { goal, fixture } from "./goal-controls-fixture"

test.each(["Pause", "Resume", "Edit", "Clear"])(
  "%s requires confirmation and uses no separate interrupt",
  async (action) => {
    const app = await fixture(goal(action === "Resume" ? "paused" : "active"))
    await app.open()
    await app.choose(action)
    if (action === "Clear") await app.view.mockInput.typeText("clear")
    if (action === "Edit") (app.state.modal!.fields[0] as TextareaRenderable).setText("Edited objective")
    expect(app.writes()).toHaveLength(0)
    app.submit()
    await app.waitFor(() => !app.state.modal)
    expect(app.writes()).toHaveLength(1)
    expect(JSON.parse(app.writes()[0]!.body)).toMatchObject({ goalID: "goal_original", expectedRevision: 7 })
    expect(app.writes().some((item) => item.path.endsWith("/interrupt"))).toBe(false)
  },
)

test.each(["Pause", "Edit", "Clear"])("ambiguous %s reconciliation never repeats writes", async (action) => {
  const app = await fixture()
  await app.open()
  await app.choose(action)
  if (action === "Clear") await app.view.mockInput.typeText("clear")
  if (action === "Edit") (app.state.modal!.fields[0] as TextareaRenderable).setText("Edited objective")
  app.remote.ambiguous = true
  app.submit()
  await app.waitFor((frame) => frame.includes("Outcome unconfirmed"))
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(1)
})

test.each(["status", "objective"])("wrong %s in successful mutation response is not acknowledged", async (field) => {
  const app = await fixture()
  await app.open()
  await app.choose("Pause")
  app.remote.response = field === "status" ? { status: "active" } : { objective: "Wrong objective" }
  app.submit()
  await app.waitFor(() => app.state.modal?.error.plainText.includes("Outcome unconfirmed") === true)
  expect(app.notices.some((text) => text.includes("acknowledged"))).toBe(false)
  expect(app.state.modal).toBeDefined()
  expect(app.writes()).toHaveLength(1)
  expect(app.requests.at(-1)!.method).toBe("POST")
})

test.each([false, true])("no-op edit accepts unchanged revision (ambiguous: %s)", async (ambiguous) => {
  const app = await fixture()
  await app.open()
  await app.choose("Edit")
  app.remote.apply = false
  app.remote.ambiguous = ambiguous
  app.submit()
  if (ambiguous) {
    await app.waitFor(() => app.state.modal?.error.plainText.includes("Outcome unconfirmed") === true)
    app.submit()
  }
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(1)
  if (ambiguous) {
    expect(app.notices).toContain("Desired goal state observed. Ordinary reply drafts are unchanged.")
    expect(app.notices.some((text) => text.includes("Execution requested"))).toBe(false)
  } else expect(app.requests.at(-1)!.method).toBe("PATCH")
})

test("unapplied ambiguous pause retries GET only", async () => {
  const app = await fixture()
  await app.open()
  await app.choose("Pause")
  app.remote.ambiguous = true
  app.remote.apply = false
  app.submit()
  await app.waitFor((frame) => frame.includes("Outcome unconfirmed"))
  app.submit()
  await app.waitFor(() => app.state.modal?.error.plainText.includes("No write repeated") === true)
  expect(app.writes()).toHaveLength(1)
})

test.each(["before", "during"])("revision conflict %s write does not overwrite newer objective", async (timing) => {
  const app = await fixture()
  await app.open()
  await app.choose("Edit")
  const editor = app.state.modal!.fields[0] as TextareaRenderable
  editor.setText("My objective")
  if (timing === "before") app.remote.goal = { ...goal(), revision: 8, objective: "Concurrent objective" }
  else app.remote.race = true
  app.submit()
  await app.waitFor((frame) => frame.includes(timing === "before" ? "Goal revision changed" : "Outcome unconfirmed"))
  app.submit()
  await app.waitFor((frame) => frame.includes("Goal revision changed"))
  expect(app.remote.goal!.objective).toBe("Concurrent objective")
  expect(app.writes()).toHaveLength(timing === "before" ? 0 : 1)
})

test.each(["selected", "identity", "owned", "undo"])("%s drift blocks writes", async (kind) => {
  const app = await fixture()
  await app.open()
  await app.choose("Pause")
  if (kind === "selected") app.state.selected = "ses_other"
  if (kind === "identity") app.remote.session = { ...app.remote.session, time: { created: 9, updated: 10 } }
  if (kind === "undo") app.remote.session = { ...app.remote.session, revert: { messageID: "msg_boundary" } }
  if (kind === "owned") app.remote.owned = true
  app.submit()
  await app.waitFor((frame) => frame.includes(kind === "owned" ? "Task-owned" : "changed"))
  expect(app.writes()).toHaveLength(0)
})
