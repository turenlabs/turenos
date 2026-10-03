import { afterEach, expect, test } from "bun:test"
import { InputRenderable, SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput } from "@turenlabs/client"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createRewindControls } from "../src/rewind"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const fileRevert: NonNullable<Session["revert"]> = {
  messageID: "msg_a",
  snapshot: "tree_original",
  diff: "patch",
  files: [{ path: "file.txt", status: "modified", additions: 1, deletions: 0, patch: "patch" }],
}
const message = (id: string, text: string, created: number, source?: "subagent_board" | "shell_job") => ({
  id,
  type: "user" as const,
  text,
  time: { created },
  ...(source ? { source } : {}),
})

async function fixture(revert?: Session["revert"], width = 100) {
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

test("staged file changes are disclosed before confirming, and Ctrl+D toggles the patch read-only", async () => {
  const app = await fixture({
    messageID: "msg_a",
    snapshot: "tree_original",
    files: [
      { path: "src/auth.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-OLDLINE\n+NEWLINE" },
      { path: "src/gone.ts", status: "deleted", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-DROPPED" },
    ],
  })
  app.controls.undo()

  // The count must be readable before the control is even finished loading,
  // because confirming can restore these files immediately.
  const initial = await app.waitFor((frame) => frame.includes("Staged file changes"))
  expect(initial).toContain("2 files · +1 -5")
  expect(initial).not.toContain("NEWLINE")

  app.view.mockInput.pressKey("d", { ctrl: true })
  const opened = await app.waitFor((frame) => frame.includes("NEWLINE"))
  expect(opened).toContain("M src/auth.ts  +1 -1")
  expect(opened).toContain("-OLDLINE")
  expect(opened).toContain("D src/gone.ts  +0 -4")

  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.waitFor((frame) => !frame.includes("NEWLINE"))
  expect(app.view.captureCharFrame()).toContain("Staged file changes")
  expect(app.posts()).toHaveLength(0)
})

test("a rewind with no staged files shows no diff affordance", async () => {
  const app = await fixture()
  await app.ready()
  expect(app.view.captureCharFrame()).not.toContain("Staged file changes")
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.view.renderOnce()
  expect(app.view.captureCharFrame()).not.toContain("Staged file changes")
  expect(app.posts()).toHaveLength(0)
})

test("confirmation does not truncate a longer word into an accepted action", async () => {
  const app = await fixture()
  await app.ready()
  await app.confirm("undone")
  await app.waitFor((frame) => frame.includes("Type undo exactly"))
  expect(app.view.renderer.currentFocusedEditor?.plainText).toBe("undone")
  expect(app.posts()).toHaveLength(0)
})

test.each(["direct", "resize"])(
  "minimum-size confirmation keeps controls visible with long metadata (%s)",
  async (mode) => {
    const app = await fixture(undefined, mode === "direct" ? 60 : 100)
    const longSession = {
      ...app.remote.session,
      title: "Long session description requiring several wrapped lines ".repeat(4),
      location: {
        ...app.remote.session.location,
        directory: "/srv/projects/very-long-project-name/packages/deeply-nested-component",
      },
    }
    app.remote.session = longSession
    app.state.snapshot!.sessions = [longSession]
    await app.ready()
    if (mode === "resize") app.view.resize(60, 24)
    await app.waitFor(
      (frame) =>
        frame.includes("Conversation only") && frame.includes("Conversation + files") && frame.includes("Type undo"),
    )
    const field = app.view.renderer.currentFocusedEditor!
    await app.view.mockInput.typeText("undo")
    await app.view.renderOnce()
    expect(field.plainText).toBe("undo")
    expect(field.y).toBeGreaterThan(app.state.modal!.form.viewport.y)
    expect(field.y).toBeLessThan(app.state.modal!.error.y)
    expect(app.view.captureCharFrame().split("\n")[field.y]).toContain("undo")
    expect(app.posts()).toHaveLength(0)
  },
)

test("retry cannot apply a hidden earlier file mode after a preflight failure", async () => {
  const app = await fixture()
  await app.ready()
  const files = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  files.setSelectedIndex(1)
  app.remote.getFailure = true
  await app.confirm()
  await app.waitFor((frame) => frame.includes("HTTP 503"))
  app.remote.getFailure = false
  files.setSelectedIndex(0)
  app.submit()
  await app.waitFor((frame) => frame.includes("original file mode"))
  expect(app.posts()).toHaveLength(0)
})

test("lost file-stage response cannot be confirmed from matching message identity alone", async () => {
  const app = await fixture()
  await app.ready()
  const files = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  files.setSelectedIndex(1)
  app.remote.ambiguous = true
  await app.confirm()
  await app.waitFor((frame) => frame.includes("Outcome unknown"))
  app.remote.session = {
    ...app.remote.session,
    revert: { messageID: "msg_a", files: [], diff: "", snapshot: "tree_original" },
  }
  app.submit()
  await app.waitFor((frame) => frame.includes("File restoration is unconfirmed"))
  expect(app.posts()).toHaveLength(2)
  expect(app.calls).toHaveLength(0)
  expect(app.notices.some((text) => text.includes("Undo confirmed"))).toBe(false)
})

test("undo inspection and Enter are read-only; captures target, defaults files false and restores draft after GET", async () => {
  const app = await fixture()
  await app.ready()
  const frame = await app.waitFor((frame) => frame.includes("Latest real prompt"))
  expect(frame).toContain("stops active work")
  expect(frame).toContain("next reply commits")
  expect(app.posts()).toEqual([])
  app.view.mockInput.pressEnter()
  app.submit()
  await app.waitFor((frame) => frame.includes("exactly"))
  expect(app.posts()).toEqual([])
  app.state.selected = "ses_elsewhere"
  await app.confirm()
  await app.waitFor(() => !app.state.modal)
  expect(app.posts().map((request) => [request.path, request.body])).toEqual([
    ["/api/session/ses_rewind/interrupt", ""],
    ["/api/session/ses_rewind/revert/stage", '{"messageID":"msg_a","files":false}'],
  ])
  expect(app.calls[0]?.[0]).toBe("changed")
  expect(app.calls[1]).toEqual(["restore", "ses_rewind", "msg_a", "Latest real prompt"])
  expect(app.state.selected).toBe("ses_elsewhere")
})

test("undo uses descending cursor order across pages and deduplicates boundary and notifications", async () => {
  const app = await fixture({ messageID: "msg_a" })
  app.remote.pages = [
    [message("msg_a", "Latest real prompt", 3)],
    [
      message("msg_a", "Latest real prompt", 3),
      message("msg_b", "Board", 2, "subagent_board"),
      message("msg_z", "Earlier real prompt", 1),
    ],
  ]
  await app.ready()
  await app.confirm()
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.posts()[1]!.body)).toEqual({ messageID: "msg_z", files: false })
  const pages = app.requests.filter((request) => request.path.endsWith("/message"))
  expect(pages).toHaveLength(2)
  expect(new URLSearchParams(pages[0]!.query).get("order")).toBe("desc")
  expect(new URLSearchParams(pages[1]!.query).get("cursor")).toBe("1")
})

test("existing file undo rejects conversation-only before interrupt; explicit file mode is honored", async () => {
  const app = await fixture(fileRevert)
  await app.ready()
  await app.confirm()
  await app.waitFor((frame) => frame.includes("Redo first"))
  expect(app.posts()).toEqual([])
  const select = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  select.setSelectedIndex(1)
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.posts()[1]!.body)).toEqual({ messageID: "msg_z", files: true })
})

test("redo advances to next real user by sequence and only clears the matching restored draft", async () => {
  const app = await fixture({ messageID: "msg_m" })
  await app.ready("redo")
  await app.confirm("redo")
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.posts()[1]!.body)).toEqual({ messageID: "msg_z", files: false })
  expect(app.calls.map((call) => call[0])).toEqual(["changed", "clear"])
  expect(app.calls[1]).toEqual(["clear", "ses_rewind", "msg_m", "First prompt"])
})

test("redo clears final stage with disclosed immediate file effects and no prompt restoration", async () => {
  const app = await fixture(fileRevert)
  await app.ready("redo")
  await app.waitFor((frame) => frame.includes("restores staged files NOW"))
  await app.confirm("redo")
  await app.waitFor(() => !app.state.modal)
  expect(app.posts().map((request) => request.path)).toEqual([
    "/api/session/ses_rewind/interrupt",
    "/api/session/ses_rewind/revert/clear",
  ])
  expect(app.calls[1]).toEqual(["clear", "ses_rewind", "msg_a", "Latest real prompt"])
})

test("undo preserves an existing reply draft when restore callback refuses", async () => {
  const app = await fixture()
  app.draft.keep = true
  await app.ready()
  await app.confirm()
  await app.waitFor(() => !app.state.modal)
  expect(app.notices.at(-1)).toContain("Existing draft kept")
  expect(app.calls).toHaveLength(2)
})

for (const action of ["undo", "redo"] as const) {
  for (const apply of [true, false]) {
    test(`${action} ambiguous response retry is GET-only (applied=${apply})`, async () => {
      const app = await fixture(action === "redo" ? fileRevert : undefined)
      app.remote.ambiguous = true
      app.remote.apply = apply
      await app.ready(action)
      await app.confirm(action)
      await app.waitFor((frame) => frame.includes("Outcome unknown"))
      expect(app.posts()).toHaveLength(2)
      app.submit()
      await app.waitFor((frame) => (apply ? !app.state.modal : frame.includes("Outcome is not confirmed")))
      expect(app.posts()).toHaveLength(2)
      expect(app.calls).toHaveLength(apply ? 2 : 0)
      if (!apply) {
        app.submit()
        await app.waitFor((frame) => frame.includes("Outcome is not confirmed"))
        expect(app.posts()).toHaveLength(2)
      }
    })
  }
  test(`${action} acknowledged mutation followed by GET failure retries only GET`, async () => {
    const app = await fixture(action === "redo" ? fileRevert : undefined)
    app.remote.failAfterWrite = true
    await app.ready(action)
    await app.confirm(action)
    await app.waitFor((frame) => frame.includes("HTTP 503"))
    expect(app.calls).toEqual([])
    app.remote.getFailure = false
    app.submit()
    await app.waitFor(() => !app.state.modal)
    expect(app.posts()).toHaveLength(2)
  })
}

for (const change of ["identity", "boundary", "ownership"] as const) {
  test(`confirmation rechecks ${change} before interruption`, async () => {
    const app = await fixture()
    await app.ready()
    if (change === "identity") app.remote.session = { ...app.remote.session, location: { directory: "/srv/other" } }
    if (change === "boundary") app.remote.session = { ...app.remote.session, revert: { messageID: "msg_m" } }
    if (change === "ownership") app.remote.blocked = true
    await app.confirm()
    await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
    expect(app.posts()).toEqual([])
  })
}

test("cancelled late message fetch cannot populate or mutate a newer modal", async () => {
  const app = await fixture()
  const gate = Promise.withResolvers<void>()
  app.remote.gate = gate.promise
  app.controls.undo()
  await app.waitFor(() => app.requests.some((request) => request.path.endsWith("/message")))
  app.view.mockInput.pressEscape()
  const newer = app.dialogs.open("Other dialog")
  gate.resolve()
  await Bun.sleep(30)
  await app.view.renderOnce()
  expect(app.state.modal).toBe(newer)
  expect(newer!.fields).toEqual([])
  expect(app.posts()).toEqual([])
})

test("missing boundary stops after ten pages without any mutation", async () => {
  const app = await fixture({ messageID: "msg_missing" })
  app.remote.pages = Array.from({ length: 12 }, (_, page) =>
    Array.from({ length: 30 }, (_, i) => message(`msg_${page}_${i}`, "A prompt", page * 30 + i)),
  )
  app.controls.undo()
  await app.waitFor((frame) => frame.includes("outside the bounded"))
  expect(app.requests.filter((request) => request.path.endsWith("/message"))).toHaveLength(10)
  app.submit()
  await app.waitFor((frame) => frame.includes("inspection"))
  expect(app.posts()).toEqual([])
})

test("known owned tasks never open rewind or make requests", async () => {
  const app = await fixture()
  app.remote.blocked = true
  app.controls.undo()
  app.controls.redo()
  expect(app.state.modal).toBeUndefined()
  expect(app.requests).toEqual([])
  expect(app.notices.at(-1)).toContain("Task-owned")
})

test("no real prompt and unstaged redo remain read-only", async () => {
  const app = await fixture()
  app.remote.pages = [[message("msg_board", "Board", 1, "subagent_board")]]
  app.controls.undo()
  await app.waitFor((frame) => frame.includes("No earlier user prompt"))
  app.view.mockInput.pressEscape()
  app.controls.redo()
  await app.waitFor((frame) => frame.includes("Nothing staged to redo"))
  expect(app.posts()).toEqual([])
})

test("ownership discovered during loading prevents controls and writes", async () => {
  const app = await fixture()
  const gate = Promise.withResolvers<void>()
  app.remote.gate = gate.promise
  app.controls.undo()
  await app.waitFor(() => app.requests.some((request) => request.path.endsWith("/message")))
  app.remote.blocked = true
  gate.resolve()
  await app.waitFor((frame) => frame.includes("Task-owned"))
  expect(app.state.modal!.fields).toEqual([])
  expect(app.posts()).toEqual([])
})
