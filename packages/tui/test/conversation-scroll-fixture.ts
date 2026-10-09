import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput, QuestionsListOutput } from "@turenlabs/client"
import { createConversation } from "../src/conversation"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"
export { cleanup }

export function message(id: string, text: string): MessagesListOutput["data"][number] {
  return { id, type: "user", text, time: { created: 1 } }
}

export async function waitForFrame(
  view: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    await view.renderOnce()
    const frame = view.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Expected frame did not appear:\n${view.captureCharFrame()}`)
}

export async function fixture(latest?: MessagesListOutput["data"]) {
  const data = {
    latest: latest ?? [message("msg_latest", Array.from({ length: 45 }, (_, i) => `Live line ${i}`).join("\n"))],
    older: [message("msg_old", "Earlier prompt\nEarlier reply")],
    next: undefined as string | undefined,
    gate: undefined as Promise<void> | undefined,
    fail: false,
    questions: [] as QuestionsListOutput,
  }
  const cursors: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/message")) {
        const cursor = url.searchParams.get("cursor")
        cursors.push(cursor)
        if (cursor) {
          await data.gate
          if (data.fail) return new Response("Unavailable", { status: 503 })
          return Response.json({ data: data.older, cursor: { next: data.next } })
        }
        return Response.json({ data: data.latest, cursor: { next: "older" } })
      }
      if (url.pathname.endsWith("/task")) return Response.json({ data: [], active: [], cursor: {} })
      if (url.pathname.includes("/question")) return Response.json({ data: data.questions })
      return Response.json({ data: [] })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const state = createDashboardState()
  const session: Session = {
    id: "ses_first",
    title: "Scroll fixture",
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
    active: {},
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
  let rendered = ""
  const renderContent = ui.renderContent
  ui.renderContent = (value, rich) => {
    rendered = value
    renderContent(value, rich)
  }
  const notices: string[] = []
  const conversation = createConversation(state, connection, ui, {
    actions() {},
    clearNotice() {},
    say(text) {
      notices.push(text)
    },
  })
  cleanup.push(conversation.dispose)
  ui.resize()
  conversation.loadPosition()
  await conversation.render()
  const newest = data.latest[0]!
  const tail =
    "text" in newest
      ? newest.text.split("\n").at(-1)!
      : newest.type === "assistant"
        ? (newest.content.findLast((part) => part.type === "text")?.text ?? "")
        : ""
  await waitForFrame(view, (frame) => !!tail && frame.includes(tail))
  const top = () => {
    conversation.cancelPosition()
    ui.detail.scrollTo(0)
  }
  return { data, state, ui, view, conversation, cursors, notices, top, content: () => rendered }
}

