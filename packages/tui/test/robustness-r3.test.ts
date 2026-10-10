import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput } from "@turenlabs/client"
import { agent, document, user, world } from "./agent-fixture"
import { createConversation } from "../src/conversation"
import { createLayout } from "../src/layout"
import { interruptedLine, turnFailure } from "../src/messages/failure"
import { connect, type Session } from "../src/server"
import { sessionRows } from "../src/session-list"
import { createDashboardState } from "../src/state"
import { assistant, mount, session as sessionFixture } from "./support"

type Message = MessagesListOutput["data"][number]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

const message = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } }) as Message
const finished = (id: string, text: string) => assistant(id, text, { finish: "stop", time: { created: 1, completed: 2 } })
const unfinished = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  assistant(id, text, { time: { created: 1 }, finish: undefined, ...extra })

async function waitFor(view: Awaited<ReturnType<typeof createTestRenderer>>, predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await view.renderOnce()
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Expected state did not appear:\n${view.captureCharFrame()}`)
}

/** A conversation on a server whose newest-first messages and failure mode the test controls. */
async function fixture(newest: Message[], options: { active?: boolean } = {}) {
  const data = { newest, next: undefined as string | undefined, down: false }
  const cursors: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (data.down) return new Response("Unavailable", { status: 503 })
      if (url.pathname.endsWith("/message")) {
        const cursor = url.searchParams.get("cursor")
        cursors.push(cursor)
        return Response.json({ data: cursor ? [] : data.newest, cursor: { next: cursor ? undefined : data.next } })
      }
      if (url.pathname.endsWith("/task")) return Response.json({ data: [], active: [], cursor: {} })
      if (url.pathname.includes("/question")) return Response.json({ data: [] })
      return Response.json({ data: [] })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const state = createDashboardState()
  const session: Session = {
    id: "ses_first",
    title: "Robust fixture",
    projectID: "project",
    agent: "build",
    location: { directory: "/fixture" },
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  state.selected = session.id
  state.snapshot = {
    location: { directory: "/fixture", project: { id: "project", directory: "/fixture" } },
    sessions: [session],
    active: options.active ? { [session.id]: { type: "running" } } : {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    terminalFolderErrors: [],
    updated: 1,
    more: false,
  }
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const ui = createLayout(view.renderer, state)
  const shown = { text: "" }
  const renderContent = ui.renderContent
  ui.renderContent = (value, rich) => {
    shown.text = value
    renderContent(value, rich)
  }
  const notices: string[] = []
  const conversation = createConversation(state, connection, ui, {
    actions() {},
    clearNotice() {},
    say: (text) => void notices.push(text),
  })
  cleanup.push(conversation.dispose)
  ui.resize()
  conversation.loadPosition()
  return { data, state, ui, view, conversation, cursors, notices, content: () => shown.text }
}

// Twelve messages of about 9,000 characters each are more than one 80,000-character part.
const long = (count: number) =>
  Array.from({ length: count }, (_, index) => message(`msg_${index}`, `MARK_${index}_ ${"x".repeat(9000)}`)).toReversed()

test("a History page too long for one view is read in parts before the next page is fetched", async () => {
  const f = await fixture(long(12))
  f.data.next = "older"
  await f.conversation.render()
  f.conversation.toggleHistory()
  await waitFor(f.view, () => f.content().includes("MARK_11_"))
  expect(f.content()).not.toContain("[earlier history shortened]")
  expect(f.content()).toMatch(/\d+ earlier messages on this page are not shown yet\. Press \[ to read them\./)
  expect(f.content()).not.toContain("MARK_0_")
  const fetches = f.cursors.filter(Boolean).length

  const seen = new Set<number>()
  for (let step = 0; step < 6 && !seen.has(0); step++) {
    const before = f.content()
    f.conversation.page("next")
    await waitFor(f.view, () => f.content() !== before)
    for (const match of f.content().matchAll(/MARK_(\d+)_/g)) seen.add(Number(match[1]))
    // Going older lands at the bottom of the older content, not at Home.
    expect(f.ui.detail.scrollTop + f.ui.detail.viewport.height).toBeGreaterThanOrEqual(f.ui.detail.scrollHeight - 1)
  }
  expect([...seen].sort((a, b) => a - b)).toContain(0)
  expect(f.cursors.filter(Boolean).length).toBe(fetches)
  expect(f.notices).not.toContain("Start of history reached.")
  // The newer parts are still there, and the way back reads them.
  expect(f.content()).toMatch(/later messages? on this page (?:is|are) not shown yet\. Press \] to read/)
  const older = f.content()
  f.conversation.page("previous")
  await waitFor(f.view, () => f.content() !== older)
  expect(f.ui.detail.scrollTop).toBe(0)
})

test("an exhausted History page then fetches the older page, and only an empty one is the start", async () => {
  const f = await fixture([message("msg_b", "second"), message("msg_a", "first")])
  f.data.next = "older"
  await f.conversation.render()
  f.conversation.toggleHistory()
  await waitFor(f.view, () => f.content().includes("second"))
  expect(f.content()).not.toContain("not shown yet")
  f.conversation.page("next")
  await waitFor(f.view, () => f.notices.includes("Start of history reached."))
  expect(f.cursors).toContain("older")
})

test("a turn the server never finished says so in the transcript, the header state and the exit code", async () => {
  const stopped = [message("msg_q", "go"), unfinished("cut", "", { content: [] })]
  expect(turnFailure(stopped as never)).toMatchObject({ state: "interrupted" })
  expect(interruptedLine(stopped as never)).toMatch(/^INTERRUPTED: .*server may have restarted/)
  expect(interruptedLine(stopped as never, true)).toMatch(/^\*\*INTERRUPTED: .*\*\*$/)
  for (const done of [
    unfinished("a", "", { time: { created: 1, completed: 2 } }),
    unfinished("b", "", { finish: "stop" }),
    unfinished("c", "", { error: { type: "unknown", message: "Provider turn interrupted" } }),
  ])
    expect(interruptedLine([message("msg_q", "go"), done] as never)).toBe("")
  expect(turnFailure([message("msg_q", "go"), finished("ok", "fine")] as never)).toBeUndefined()
  expect(turnFailure([message("msg_q", "go"), finished("ok", "fine"), unfinished("cut", "")] as never)).toMatchObject({
    state: "interrupted",
  })

  const server = world()
  server.state.messages = [user("q", "go"), unfinished("cut", "")]
  const waited = await agent(["wait", "ses_main"], { url: server.url })
  expect(waited.code).toBe(5)
  expect(waited.stdout).toContain("session ses_main · interrupted")
  expect(waited.stdout).toContain("without a recorded finish")
  expect(document(await agent(["wait", "ses_main", "--json"], { url: server.url }))).toMatchObject({
    state: "interrupted",
  })
  const shown = await agent(["show", "ses_main"], { url: server.url })
  expect(shown.stdout).toContain("session ses_main · interrupted")
  expect(shown.stdout).toContain("INTERRUPTED: The turn ended without a recorded finish")
  expect(
    (await agent(["sessions", "--json"], { url: server.url })).stdout,
  ).toContain('"state":"interrupted"')

  const f = await fixture([unfinished("cut", "") as Message, message("msg_q", "go")])
  await f.conversation.render()
  f.conversation.toggleHistory()
  await waitFor(f.view, () => f.content().includes("INTERRUPTED:"))
  // A turn that is running has not finished yet.
  const running = await fixture([unfinished("cut", "") as Message, message("msg_q", "go")], { active: true })
  await running.conversation.render()
  running.conversation.toggleHistory()
  await waitFor(running.view, () => running.content().includes("go"))
  expect(running.content()).not.toContain("INTERRUPTED:")
})

test("wait polls a server that is down when it starts, on the same schedule as a failing wait", async () => {
  const first = world()
  const port = first.listener.port
  await first.listener.stop(true)
  const started = Date.now()
  const waiting = agent(["wait", "ses_main", "--timeout", "30"], { url: `http://127.0.0.1:${port}` })
  await Bun.sleep(500)
  const second = world()
  const revived = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => second.listener.fetch(request) })
  cleanup.push(() => revived.stop(true))
  const result = await waiting
  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("session ses_main · idle")
  // The first failure waits about two seconds, as a failing pass of the wait loop does.
  expect(Date.now() - started).toBeGreaterThanOrEqual(1800)
})

test("wait against a server that stays down gives up at the timeout with exit 1; a refused login does not retry", async () => {
  const down = world()
  const port = down.listener.port
  await down.listener.stop(true)
  const started = Date.now()
  const result = await agent(["wait", "ses_main", "--timeout", "1"], { url: `http://127.0.0.1:${port}` })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Connection failed")
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)

  const locked = world({}, "secret")
  const begin = Date.now()
  const refused = await agent(["wait", "ses_main", "--timeout", "30"], { url: locked.url })
  expect(refused.code).toBe(1)
  expect(Date.now() - begin).toBeLessThan(1500)
  const missing = world({
    "GET /api/session/ses_main": () => Response.json({ _tag: "SessionNotFoundError", message: "gone" }, { status: 404 }),
  })
  const absent = await agent(["wait", "ses_main", "--timeout", "30"], { url: missing.url })
  expect(absent.code).toBe(1)
  expect(absent.stderr).toContain("No session ses_main")
})

test("a disconnected view keeps the cached transcript and puts the error in the status line only", async () => {
  const f = await fixture([finished("reply", "Saved reply text") as Message, message("msg_q", "question")])
  await f.conversation.render()
  await waitFor(f.view, () => f.content().includes("Saved reply text"))
  f.data.down = true
  await f.conversation.render()
  await waitFor(f.view, () => f.notices.some((text) => text.startsWith("Details unavailable")))
  expect(f.content()).toContain("Saved reply text")
  expect(f.content()).not.toContain("Details unavailable")

  // With nothing cached, the pane itself says why.
  const empty = await fixture([message("msg_q", "question")])
  empty.data.down = true
  await empty.conversation.render()
  expect(empty.content()).toContain("Details unavailable")
})

test("sidebar rows of a disconnected view do not claim live state", () => {
  const sessions = [sessionFixture("main") as Session]
  const active = { [sessions[0]!.id]: { type: "running" } }
  const live = sessionRows(sessions, active, [sessions[0]!.id])
  expect(live[0]).toMatchObject({ running: true, needsInput: true })
  const stale = sessionRows(sessions, active, [sessions[0]!.id], true)
  expect(stale[0]).toMatchObject({ running: false, needsInput: false })
  expect(stale[0]!.name.startsWith("* ")).toBe(false)
  expect(stale[0]!.name.startsWith("? ")).toBe(false)
  expect(stale[0]!.description).toContain("stale")
})

test("the live transcript says when an idle session's last turn never finished", async () => {
  const { screen } = await mount(
    120,
    { "GET /api/session/ses_main/message": () => ({ data: [unfinished("main", "partial reply")], cursor: {} }) },
    36,
    "",
    "partial reply",
  )
  const frame = await screen("INTERRUPTED: The turn ended without a recorded finish")
  expect(frame).toContain("partial reply")
})

test("the live transcript of a finished turn carries no interrupted line", async () => {
  const { view } = await mount(120, {}, 36)
  expect(view.captureCharFrame()).not.toContain("INTERRUPTED")
})
