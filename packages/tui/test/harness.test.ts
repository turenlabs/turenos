import { afterEach, expect, test } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { SessionsStateOutput } from "@turenlabs/client"
import { createDialogs } from "../src/dialogs"
import { createHarnessControls } from "../src/harness"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

type Snapshot = NonNullable<SessionsStateOutput["snapshot"]>
type Proposal = SessionsStateOutput["proposals"][number]
type Harness = Omit<{ -readonly [K in keyof SessionsStateOutput]: SessionsStateOutput[K] }, "proposals"> & {
  proposals: Proposal[]
}

const validation = { status: "passed", errors: [], warnings: [] } as const
const snapshot = (version: number, source: Snapshot["source"] = "default"): Snapshot => ({
  version,
  status: "active",
  source,
  changes: [],
  tools: [{ name: "harness_callers", description: "Find callers", readOnly: true, enabled: true }],
  guidance: [{ directive: "Check callers before editing", appliesTo: "src/mem.rs" }],
  validation,
  timestamps: { created: 1, updated: 1 },
})
const proposal = (status: Proposal["status"] = "pending"): Proposal => ({
  id: "hpr_one",
  baseVersion: 2,
  summary: "Add caller guidance",
  changes: [{ path: "harness/callers.ts", operation: "add", summary: "caller lookup" }],
  guidance: [{ directive: "Run harness_callers before editing mem.rs" }],
  status,
  validation,
  timestamps: { created: 2, updated: 2 },
})

async function fixture(options: { status?: Proposal["status"]; owned?: boolean } = {}) {
  const session: Session = {
    id: "ses_harness",
    projectID: "project",
    title: "Harnessed session",
    agent: "build",
    location: { directory: "/srv/project" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const remote = {
    harness: {
      snapshot: snapshot(2),
      proposals: [proposal(options.status)],
      reviewerRequests: [],
      reviewerRuns: [{ reviewerSessionID: "ses_review", outcome: "proposed", detail: "one idea", timestamp: 3 }],
    } as Harness,
    ambiguous: false,
    malformed: false,
    applyRefused: false,
  }
  const requests: { method: string; path: string; body: string }[] = []
  const base = `/api/session/${session.id}/harness`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.text()
      requests.push({ method: request.method, path, body })
      const state = remote.harness
      if (request.method === "GET" && path === base)
        return Response.json({
          data: remote.malformed ? { ...state, snapshot: { ...state.snapshot, tools: [{ name: 1 }] } } : state,
        })
      const input = body ? JSON.parse(body) : {}
      const current = state.proposals[0]!
      const next = (source: Snapshot["source"]) => {
        state.snapshot = snapshot(state.snapshot!.version + 1, source)
        return state.snapshot
      }
      let data: unknown
      if (path.endsWith("/status")) data = state.proposals[0] = { ...current, status: input.status }
      else if (path.endsWith("/reject")) data = state.proposals[0] = { ...current, status: "rejected" }
      else if (path.endsWith("/apply")) {
        if (remote.applyRefused)
          return Response.json({ _tag: "InvalidRequestError", message: "proposal no longer valid" }, { status: 400 })
        if (current.status !== "approved") return Response.json({ message: "not approved" }, { status: 409 })
        data = next("proposal")
        state.proposals[0] = { ...current, status: "applied", appliedVersion: state.snapshot!.version }
      } else if (path.endsWith("/reload") || path.endsWith("/rollback")) {
        if (input.baseVersion !== state.snapshot!.version) return Response.json({ message: "stale" }, { status: 409 })
        data = next(path.endsWith("/reload") ? "reload" : "rollback")
      } else return new Response(null, { status: 404 })
      if (remote.ambiguous) return new Response("lost acknowledgement", { status: 503 })
      return Response.json({ data })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({ width: 110, height: 42 })
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
  const say = (message: string) => void notices.push(message)
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
  const controls = createHarnessControls(view.renderer, state, connection, dialogs, say, () => !!options.owned)
  async function waitFor(predicate: (frame: string) => boolean) {
    for (let index = 0; index < 400; index++) {
      await view.renderOnce()
      if (predicate(view.captureCharFrame())) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Expected harness state missing:\n${view.captureCharFrame()}`)
  }
  const writes = () =>
    requests.filter((item) => item.method !== "GET").map((item) => [item.path.slice(base.length), item.body])
  async function choose(prefix: string) {
    controls.open()
    await waitFor((frame) => frame.includes("Ctrl+R refresh"))
    const field = state.modal!.fields.find((item) => item instanceof SelectRenderable) as SelectRenderable
    const index = field.options.findIndex((item) => item.name.startsWith(prefix))
    expect(index).toBeGreaterThanOrEqual(0)
    field.setSelectedIndex(index)
    view.mockInput.pressEnter()
    await waitFor((frame) => frame.includes("Nothing changed yet"))
  }
  return { remote, writes, state, view, notices, waitFor, controls, choose }
}

test("opening shows the active harness, reviewer runs, and proposals without writing", async () => {
  const app = await fixture()
  app.controls.open()
  const frame = await app.waitFor((frame) => frame.includes("REVIEWER"))
  for (const text of [
    "Snapshot v2 · active · from default · validation passed",
    "harness_callers · read-only — Find callers",
    "• Check callers before editing (src/mem.rs)",
    "PROPOSALS · 1 pending",
    "[pending] Add caller guidance",
    "proposed — one idea",
    "Approve and apply: Add caller guidance",
    "Roll back to v1",
  ])
    expect(frame).toContain(text)
  expect(app.writes()).toEqual([])
})

test("approving shows the proposal, needs Ctrl+S, then approves before applying", async () => {
  const app = await fixture()
  await app.choose("Approve and apply")
  const frame = app.view.captureCharFrame()
  expect(frame).toContain("add harness/callers.ts — caller lookup")
  expect(frame).toContain("• Run harness_callers before editing mem.rs")
  app.view.mockInput.pressEnter()
  await app.view.renderOnce()
  expect(app.writes()).toEqual([])
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => app.notices.some((notice) => notice.startsWith("Proposal applied")))
  expect(app.writes()).toEqual([
    ["/proposal/hpr_one/status", JSON.stringify({ status: "approved" })],
    ["/proposal/hpr_one/apply", ""],
  ])
  expect(app.remote.harness.snapshot?.version).toBe(3)
})

test("an approved proposal only needs applying, and reject leaves the snapshot alone", async () => {
  const approved = await fixture({ status: "approved" })
  await approved.choose("Apply:")
  approved.view.mockInput.pressKey("s", { ctrl: true })
  await approved.waitFor(() => approved.notices.some((notice) => notice.startsWith("Proposal applied")))
  expect(approved.writes()).toEqual([["/proposal/hpr_one/apply", ""]])

  const rejected = await fixture()
  await rejected.choose("Reject:")
  rejected.view.mockInput.pressKey("s", { ctrl: true })
  await rejected.waitFor(() => rejected.notices.includes("Proposal rejected."))
  expect(rejected.writes()).toEqual([["/proposal/hpr_one/reject", ""]])
  expect(rejected.remote.harness.snapshot?.version).toBe(2)
})

test("rollback sends the reviewed version and a change elsewhere sends nothing", async () => {
  const app = await fixture()
  await app.choose("Roll back to v1")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => app.notices.includes("Harness rolled back to v1."))
  expect(app.writes()).toEqual([["/rollback", JSON.stringify({ baseVersion: 2, version: 1 })]])

  const stale = await fixture()
  await stale.choose("Reload harness (v2)")
  stale.remote.harness.snapshot = snapshot(5)
  stale.view.mockInput.pressKey("s", { ctrl: true })
  await stale.waitFor((frame) => frame.includes("The harness changed"))
  expect(stale.writes()).toEqual([])
})

test("after an uncertain result, retries only recheck and report the observed outcome", async () => {
  const app = await fixture()
  await app.choose("Reject:")
  app.remote.ambiguous = true
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor((frame) => frame.includes("Outcome unconfirmed"))
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => app.notices.includes("Harness change observed."))
  expect(app.writes()).toHaveLength(1)
})

test("a definitely rejected apply after a successful approval retries by applying only", async () => {
  const app = await fixture()
  await app.choose("Approve and apply")
  app.remote.applyRefused = true
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor((frame) => frame.includes("proposal no longer valid"))
  expect(app.view.captureCharFrame()).not.toContain("Outcome unconfirmed")
  app.remote.applyRefused = false
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => app.notices.some((notice) => notice.startsWith("Proposal applied")))
  expect(app.writes()).toEqual([
    ["/proposal/hpr_one/status", JSON.stringify({ status: "approved" })],
    ["/proposal/hpr_one/apply", ""],
    ["/proposal/hpr_one/apply", ""],
  ])
})

test("task-owned sessions are read-only and malformed harness data is refused", async () => {
  const owned = await fixture({ owned: true })
  owned.controls.open()
  const frame = await owned.waitFor((frame) => frame.includes("Task-owned session: read-only."))
  expect(frame).not.toContain("Approve and apply")

  const malformed = await fixture()
  malformed.remote.malformed = true
  malformed.controls.open()
  await malformed.waitFor((frame) => frame.includes("Harness unavailable") && frame.includes("Invalid server response"))
})
