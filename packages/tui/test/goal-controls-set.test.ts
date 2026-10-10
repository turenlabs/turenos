import { expect, test } from "bun:test"
import { InputRenderable, SelectRenderable, TextareaRenderable } from "@opentui/core"
import { goal, fixture } from "./goal-controls-fixture"

test("opening is read-only, usage refresh preserves action selection and focus", async () => {
  const app = await fixture()
  await app.open()
  const field = app.selector()
  field.setSelectedIndex(2)
  expect(app.view.captureCharFrame()).toContain("Tokens: 123")
  app.remote.goal = { ...goal(), revision: 8, tokensUsed: 456 }
  app.state.modal!.refresh!()
  app.state.modal!.refresh!()
  await app.waitFor((frame) => frame.includes("Tokens: 456"))
  expect(field.getSelectedIndex()).toBe(2)
  expect(field.focused).toBe(true)
  expect(app.writes()).toHaveLength(0)
})

test("loaded actions remain responsive during a slow background refresh", async () => {
  const app = await fixture()
  await app.open()
  let release!: () => void
  app.remote.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const gets = app.requests.filter((item) => item.path.endsWith("/goal")).length
  app.state.modal!.refresh!()
  try {
    await app.waitFor(() => app.requests.filter((item) => item.path.endsWith("/goal")).length > gets)
    await app.choose("Edit")
    expect(app.state.modal!.fields[0]).toBeInstanceOf(TextareaRenderable)
    expect(app.writes()).toHaveLength(0)
  } finally {
    release()
  }
})

test("Edit opens with the cursor after the prefilled objective and the overview is not called read-only", async () => {
  const app = await fixture()
  await app.open()
  expect(app.view.captureCharFrame()).not.toContain("Read-only.")
  await app.choose("Edit")
  const editor = app.state.modal!.fields[0] as TextareaRenderable
  expect(editor.cursorOffset).toBe("Original objective".length)
  await app.view.mockInput.typeText(" edited")
  expect(editor.plainText).toBe("Original objective edited")
})

test("Set is explicit, Enter inserts newline, Ctrl+S starts with captured settings", async () => {
  const app = await fixture(null)
  await app.open()
  await app.choose("Set")
  expect(app.state.modal!.editor).toBeUndefined()
  await app.view.mockInput.typeText("First line")
  app.view.mockInput.pressEnter()
  await app.view.mockInput.typeText("Second line")
  const editor = app.state.modal!.fields[0] as TextareaRenderable
  expect(editor.plainText).toBe("First line\nSecond line")
  expect(app.writes()).toHaveLength(0)
  app.submit()
  await app.waitFor(() => !app.state.modal)
  const request = app.writes()[0]!
  expect(request.method).toBe("PUT")
  expect(JSON.parse(request.body)).toMatchObject({
    objective: "First line\nSecond line",
    agent: "build",
    model: { variant: "high" },
  })
  expect(app.writes()).toHaveLength(1)
})

test("a submit that sent nothing leaves the objective editable", async () => {
  const app = await fixture(null)
  await app.open()
  await app.choose("Set")
  await app.view.mockInput.typeText("First draft")
  app.remote.getFails = true
  app.submit()
  await app.waitFor((frame) => frame.includes("HTTP 500"))
  expect(app.writes()).toHaveLength(0)
  app.remote.getFails = false
  const editor = app.state.modal!.fields[0] as TextareaRenderable
  editor.setText("Second draft")
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.writes()[0]!.body)).toMatchObject({ objective: "Second draft" })
})

test("a definitely refused Set unfreezes the objective for an edit", async () => {
  const app = await fixture(null)
  await app.open()
  await app.choose("Set")
  await app.view.mockInput.typeText("First draft")
  app.remote.refuse = true
  app.submit()
  await app.waitFor((frame) => frame.includes("Rejected by the server"))
  app.remote.refuse = false
  ;(app.state.modal!.fields[0] as TextareaRenderable).setText("Second draft")
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.writes().at(-1)!.body)).toMatchObject({ objective: "Second draft" })
})

test("creation retry retains IDs and frozen agent/model", async () => {
  const app = await fixture(null)
  await app.open()
  await app.choose("Set")
  await app.view.mockInput.typeText("Stable objective")
  app.remote.ambiguous = true
  app.remote.apply = false
  app.submit()
  await app.waitFor((frame) => frame.includes("Outcome unconfirmed"))
  app.state.snapshot!.sessions = [
    { ...app.remote.session, agent: "other", model: { id: "other", providerID: "other" } },
  ]
  app.remote.ambiguous = false
  app.remote.apply = true
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(2)
  expect(app.writes()[0]!.body).toBe(app.writes()[1]!.body)
  expect(JSON.parse(app.writes()[0]!.body).id).toStartWith("goal_")
  expect(JSON.parse(app.writes()[0]!.body).messageID).toStartWith("msg_")
})

test("60x24 new goal with staged undo keeps commit warning and objective input visible", async () => {
  const app = await fixture(null, 60)
  app.remote.session = { ...app.remote.session, revert: { messageID: "msg_boundary" }, title: "Long title ".repeat(30) }
  app.state.snapshot!.sessions = [app.remote.session]
  await app.open()
  await app.choose("Set")
  await app.view.mockInput.typeText("VISIBLE GOAL INPUT")
  const frame = await app.waitFor(
    (frame) => frame.includes("COMMITS staged undo") && frame.includes("VISIBLE GOAL INPUT"),
  )
  expect(frame).toContain("STARTS execution")
  expect(app.writes()).toHaveLength(0)
})

test("applied Set reconciles after committing staged undo without another write", async () => {
  const app = await fixture(null)
  app.remote.session = { ...app.remote.session, revert: { messageID: "msg_boundary" } }
  app.state.snapshot!.sessions = [app.remote.session]
  await app.open()
  await app.choose("Set")
  await app.view.mockInput.typeText("Goal after undo")
  app.remote.ambiguous = true
  app.submit()
  await app.waitFor((frame) => frame.includes("Outcome unconfirmed"))
  app.remote.session = { ...app.remote.session, revert: undefined }
  app.state.snapshot!.sessions = [app.remote.session]
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(1)
  expect(app.notices.at(-1)).toContain("Desired goal state observed")
})

test("owned overview stays readable; completed goal can be replaced but not edited", async () => {
  const app = await fixture(goal("complete"))
  app.remote.owned = true
  await app.open()
  expect(app.selector().options.map((item) => item.name)).toEqual(["Set", "Clear"])
  app.view.mockInput.pressEnter()
  expect(app.state.modal!.fields[0]).toBeInstanceOf(SelectRenderable)
  expect(app.writes()).toHaveLength(0)
})

test("cancel returns to captured overview without writes; late GET cannot reopen closed dialog", async () => {
  const app = await fixture()
  await app.open()
  await app.choose("Edit")
  app.view.mockInput.pressKey("ESCAPE")
  await app.waitFor((frame) => frame.includes("Up/Down choose"))
  let release!: () => void
  app.remote.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  app.state.modal!.refresh!()
  app.view.mockInput.pressKey("ESCAPE")
  release()
  await Bun.sleep(30)
  expect(app.state.modal).toBeUndefined()
  expect(app.writes()).toHaveLength(0)
})

test.each(["direct", "resize"])("60x24 keeps warning and actual clear input visible (%s)", async (mode) => {
  const app = await fixture(goal(), mode === "direct" ? 60 : 100)
  const session = { ...app.remote.session, title: "Very long title ".repeat(30) }
  app.remote.session = session
  app.state.snapshot!.sessions = [session]
  await app.open()
  await app.choose("Clear")
  if (mode === "resize") app.view.resize(60, 24)
  await app.view.mockInput.typeText("clearer")
  await app.waitFor((frame) => frame.includes("STOPS active work") && frame.includes("clearer"))
  const field = app.state.modal!.fields[0] as InputRenderable
  expect(app.view.captureCharFrame().split("\n")[field.y]).toContain("clearer")
  app.submit()
  await app.waitFor((frame) => frame.includes("Type clear to confirm"))
  expect(app.writes()).toHaveLength(0)
})
