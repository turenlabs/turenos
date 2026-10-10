import { InputRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput } from "@turenlabs/client"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createRewindControls } from "../src/rewind"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"

export const fileRevert: NonNullable<Session["revert"]> = {
  messageID: "msg_a",
  snapshot: "tree_original",
  diff: "patch",
  files: [{ path: "file.txt", status: "modified", additions: 1, deletions: 0, patch: "patch" }],
}

export const message = (id: string, text: string, created: number, source?: "subagent_board" | "shell_job") => ({
  id,
  type: "user" as const,
  text,
  time: { created },
  ...(source ? { source } : {}),
})

export async function fixture(revert?: Session["revert"], width = 100) {
  const session: Session = {
    id: "ses_rewind",
    projectID: "project",
    title: "Captured rewind",
    agent: "build",
    location: { directory: "/srv/project", workspaceID: "workspace" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(revert ? { revert } : {}),
  }
  const remote = {
    session: structuredClone(session),
    // UUID-like IDs deliberately sort differently from chronological sequence.
    pages: [
      [
        message("msg_0", "Job notification", 4, "shell_job"),
        message("msg_a", "Latest real prompt", 3),
        message("msg_z", "Earlier real prompt", 2),
        message("msg_m", "First prompt", 1),
      ],
    ] as MessagesListOutput["data"][],
    blocked: false,
    gate: undefined as Promise<void> | undefined,
    ambiguous: false,
    apply: true,
    getFailure: false,
    failAfterWrite: false,
  }
  const requests: { method: string; path: string; query: string; body: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.text()
      requests.push({ method: request.method, path: url.pathname, query: url.search, body })
      if (request.method === "GET" && url.pathname === "/api/session/ses_rewind") {
        if (remote.getFailure) return new Response(null, { status: 503 })
        return Response.json({ data: remote.session })
      }
      if (request.method === "GET" && url.pathname === "/api/session/ses_rewind/message") {
        await remote.gate
        const index = Number(url.searchParams.get("cursor") ?? 0)
        return Response.json({
          data: remote.pages[index] ?? [],
          cursor: { next: index + 1 < remote.pages.length ? String(index + 1) : null },
        })
      }
      if (request.method === "POST" && url.pathname.endsWith("/interrupt")) return new Response(null, { status: 204 })
      if (request.method === "POST" && url.pathname.endsWith("/revert/stage")) {
        const input = JSON.parse(body)
        const next = input.files
          ? { ...fileRevert, messageID: input.messageID }
          : { messageID: input.messageID, files: [], diff: "", snapshot: "tree_original" }
        if (remote.apply) remote.session = { ...remote.session, revert: next }
        if (remote.failAfterWrite) remote.getFailure = true
        if (remote.ambiguous) return new Response("response lost", { status: 500 })
        return Response.json({ data: next })
      }
      if (request.method === "POST" && url.pathname.endsWith("/revert/clear")) {
        if (remote.apply) remote.session = { ...remote.session, revert: undefined }
        if (remote.failAfterWrite) remote.getFailure = true
        if (remote.ambiguous) return new Response("response lost", { status: 500 })
        return new Response(null, { status: 204 })
      }
      return new Response("Unexpected route", { status: 404 })
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
  const say = (text: string) => {
    notices.push(text)
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
  const calls: unknown[][] = []
  const draft = { keep: false }
  const controls = createRewindControls(view.renderer, state, connection, dialogs, say, {
    blocked: () => remote.blocked,
    changed: (updated) => {
      calls.push(["changed", updated])
    },
    restoreDraft: (updated, id, text) => {
      calls.push(["restore", updated.id, id, text])
      return !draft.keep
    },
    clearRestoredDraft: (id, boundary, text) => {
      calls.push(["clear", id, boundary, text])
    },
  })
  async function waitFor(predicate: (frame: string) => boolean) {
    for (let attempt = 0; attempt < 400; attempt++) {
      await view.renderOnce()
      if (predicate(view.captureCharFrame())) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Expected rewind state did not appear:\n${view.captureCharFrame()}`)
  }
  async function ready(action: "undo" | "redo" = "undo") {
    controls[action]()
    await waitFor(() => state.modal?.fields.some((field) => field instanceof InputRenderable) === true)
  }
  const submit = () => view.mockInput.pressKey("s", { ctrl: true })
  async function confirm(action = "undo") {
    await view.mockInput.typeText(action)
    submit()
  }
  const posts = () => requests.filter((request) => request.method === "POST")
  return {
    remote,
    requests,
    state,
    view,
    controls,
    dialogs,
    notices,
    calls,
    draft,
    waitFor,
    ready,
    confirm,
    submit,
    posts,
  }
}
