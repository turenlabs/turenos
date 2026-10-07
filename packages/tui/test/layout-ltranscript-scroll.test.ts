import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput } from "@turenlabs/client"
import { createConversation } from "../src/conversation"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ")
const messages: MessagesListOutput["data"] = [
  { id: "msg_user", type: "user", text: "tell me a long story", time: { created: 1 } },
  {
    id: "msg_story",
    type: "assistant",
    agent: "build",
    model: { providerID: "sandbox", id: "scripted" },
    time: { created: 2 },
    content: [{ id: "part_text", type: "text", text: words }],
  } as MessagesListOutput["data"][number],
]

async function fixture(width: number, height: number) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/message")) return Response.json({ data: messages, cursor: {} })
      if (path.endsWith("/task")) return Response.json({ data: [], active: [], cursor: {} })
      return Response.json({ data: [] })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const state = createDashboardState()
  const session: Session = {
    id: "ses_resize",
    title: "Resize fixture",
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
  const view = await createTestRenderer({ width, height })
  cleanup.push(() => view.renderer.destroy())
  const ui = createLayout(view.renderer, state)
  const conversation = createConversation(state, connection, ui, { actions() {}, clearNotice() {}, say() {} })
  cleanup.push(conversation.dispose)
  ui.resize()
  conversation.loadPosition()
  await conversation.render()
  return { view, ui, conversation }
}

async function settle(view: Awaited<ReturnType<typeof fixture>>["view"]) {
  for (let frame = 0; frame < 5; frame++) {
    await view.renderOnce()
    await Bun.sleep(10)
  }
}

test("a transcript that fits after a resize shows from its first line", async () => {
  const f = await fixture(80, 24)
  await settle(f.view)
  expect(f.ui.detail.scrollHeight).toBeGreaterThan(f.ui.detail.viewport.height)
  f.ui.detail.scrollTo(Number.MAX_SAFE_INTEGER)
  await settle(f.view)
  expect(f.ui.detail.scrollTop).toBeGreaterThan(0)
  f.view.resize(160, 48)
  f.ui.resize()
  await settle(f.view)
  expect(f.ui.detail.scrollHeight).toBeLessThanOrEqual(f.ui.detail.viewport.height)
  expect(f.ui.detail.scrollTop).toBe(0)
  expect(f.view.captureCharFrame()).toContain("tell me a long story")
})

test("a transcript read from the middle and then widened shows from its first line", async () => {
  const f = await fixture(80, 24)
  await settle(f.view)
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(6)
  await settle(f.view)
  expect(f.ui.detail.scrollTop).toBe(6)
  f.view.resize(160, 48)
  f.ui.resize()
  await settle(f.view)
  expect(f.ui.detail.scrollTop).toBe(0)
  expect(f.view.captureCharFrame()).toContain("tell me a long story")
})
