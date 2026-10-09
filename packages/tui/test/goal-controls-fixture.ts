import { expect } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { SessionsGoalGetOutput } from "@turenlabs/client"
import { createDialogs } from "../src/dialogs"
import { createGoalControls } from "../src/goal-controls"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"

export const goal = (status: NonNullable<SessionsGoalGetOutput>["status"] = "active"): NonNullable<SessionsGoalGetOutput> => ({
  id: "goal_original",
  sessionID: "ses_goal",
  revision: 7,
  objective: "Original objective",
  status,
  tokensUsed: 123,
  timeUsedSeconds: 45,
  time: { created: 1, updated: 2, statusChanged: 1 },
})

export async function fixture(initial: SessionsGoalGetOutput = goal(), width = 100) {
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
    refuse: false,
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
      if (remote.refuse) return Response.json({ _tag: "InvalidRequestError", message: "Goal refused" }, { status: 400 })
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
    terminalFolderErrors: [],
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

