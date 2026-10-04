import { afterEach, expect, test } from "bun:test"
import { InputRenderable, SelectRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { SessionsGoalGetOutput } from "@turenlabs/client"
import { createDialogs } from "../src/dialogs"
import { createGoalControls } from "../src/goal-controls"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const goal = (status: NonNullable<SessionsGoalGetOutput>["status"] = "active"): NonNullable<SessionsGoalGetOutput> => ({
  id: "goal_original",
  sessionID: "ses_goal",
  revision: 7,
  objective: "Original objective",
  status,
  tokensUsed: 123,
  timeUsedSeconds: 45,
  time: { created: 1, updated: 2, statusChanged: 1 },
})

async function fixture(initial: SessionsGoalGetOutput = goal(), width = 100) {
  const session: Session = {
    id: "ses_goal",
    projectID: "project",
    title: "Captured goal",
    agent: "build",
    model: { id: "model", providerID: "provider", variant: "high" },
    location: { directory: "/srv/project", workspaceID: "workspace" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const remote = {
    session: structuredClone(session),
    goal: initial,
    owned: false,
    ambiguous: false,
    apply: true,
    gate: undefined as Promise<void> | undefined,
    race: false,
    getFails: false,
    response: undefined as Partial<NonNullable<SessionsGoalGetOutput>> | undefined,
  }
  const requests: { method: string; path: string; body: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.text()
      requests.push({ method: request.method, path, body })
      if (request.method === "GET") {
        if (path.endsWith("/goal")) {
          if (remote.getFails) return new Response("down", { status: 500 })
          await remote.gate
          return Response.json({ data: remote.goal })
        }
        if (path === "/api/session/ses_goal") return Response.json({ data: remote.session })
      }
      if (!path.includes("/goal")) return new Response("Unexpected route", { status: 404 })
      const input = JSON.parse(body)
      if (remote.race && remote.goal)
        remote.goal = { ...remote.goal, revision: remote.goal.revision + 1, objective: "Concurrent objective" }
      if (
        request.method !== "PUT" &&
        (!remote.goal || input.goalID !== remote.goal.id || input.expectedRevision !== remote.goal.revision)
      )
        return Response.json({ name: "SessionGoalConflictError", message: "revision conflict" }, { status: 409 })
      if (remote.apply) {
        if (request.method === "PUT") {
          if (remote.goal && remote.goal.status !== "complete" && remote.goal.id !== input.id)
            return Response.json({ name: "SessionGoalConflictError", message: "unfinished goal" }, { status: 409 })
          remote.goal = { ...goal(), id: input.id, objective: input.objective, revision: 1 }
        } else if (request.method === "DELETE") remote.goal = null
        else
          remote.goal = {
            ...remote.goal!,
            revision: remote.goal!.revision + 1,
            ...(request.method === "PATCH" ? { objective: input.objective } : { status: input.status }),
          }
      }
      if (remote.ambiguous) return new Response("lost acknowledgement", { status: 503 })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json({ data: remote.response ? { ...remote.goal, ...remote.response } : remote.goal })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({ width, height: width === 60 ? 24 : 42, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.selected = session.id
  state.snapshot = {
    location: { directory: "/srv/project", project: { id: "project", directory: "/srv/project" } },
    sessions: [session],
    active: {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    updated: 2,
    more: false,
  }
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  const ui = createLayout(view.renderer, state)
  const notices: string[] = []
  const say = (message: string) => {
    notices.push(message)
  }
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition: () => {},
    cancelPosition: () => {},
    changed: () => {
      ui.resize()
      ui.focus()
    },
    submitted: async () => {},
    say,
  })
  view.renderer.keyInput.on("keypress", dialogs.keypress)
  const controls = createGoalControls(view.renderer, state, connection, dialogs, say, () => remote.owned)
  async function waitFor(predicate: (frame: string) => boolean) {
    for (let index = 0; index < 400; index++) {
      await view.renderOnce()
      if (predicate(view.captureCharFrame())) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Expected goal state missing:\n${view.captureCharFrame()}`)
  }
  const writes = () => requests.filter((item) => item.method !== "GET")
  const selector = () => state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  async function open() {
    controls.open()
    await waitFor((frame) => frame.includes("Up/Down choose"))
  }
  async function choose(action: string) {
    const field = selector()
    const index = field.options.findIndex((item) => item.name === action)
    expect(index).toBeGreaterThanOrEqual(0)
    field.setSelectedIndex(index)
    view.mockInput.pressEnter()
    await waitFor(() => !state.modal?.fields.some((item) => item instanceof SelectRenderable))
  }
  const submit = () => view.mockInput.pressKey("s", { ctrl: true })
  return { remote, requests, writes, state, view, dialogs, controls, notices, waitFor, open, choose, submit, selector }
}

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
  await app.waitFor((frame) => frame.includes("Type clear exactly"))
  expect(app.writes()).toHaveLength(0)
})
