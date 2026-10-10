import { expect } from "bun:test"
import { InputRenderable, SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createRequests } from "../src/requests"
import { connect, type Detail } from "../src/server"
import { createSlashCommands } from "../src/slash"
import { createMentions } from "../src/mentions"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"

export const single = {
  header: "Approach",
  question: "Which approach should we use?",
  custom: false,
  options: [
    { label: "Small change", description: "Keep the existing design." },
    { label: "New design", description: "Replace the current design." },
  ],
}

export async function fixture(questions: Detail["questions"][number]["questions"], width = 100, height = 36) {
  const posts: { path: string; body: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 404 })
      posts.push({ path: new URL(request.url).pathname, body: await request.text() })
      return new Response(null, { status: 204 })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({ width, height, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.selected = "ses_question"
  state.detail = {
    sessionID: state.selected,
    messages: [],
    cursor: {},
    tasks: { data: [], active: [], cursor: {} },
    permissions: [],
    pending: [],
    todos: [],
    questions: [{ id: "que_picker", sessionID: state.selected, questions }],
  }
  const ui = createLayout(view.renderer, state)
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition() {},
    cancelPosition() {},
    changed() {
      ui.resize()
    },
    async submitted() {},
    say() {},
  })
  view.renderer.keyInput.on("keypress", dialogs.keypress)
  view.renderer.on("resize", ui.resize)
  const requests = createRequests(
    view.renderer,
    state,
    connection,
    dialogs,
    () => {},
    () => {},
    createSlashCommands(
      view.renderer,
      state,
      connection,
      () => [],
      () => {},
    ),
    createMentions(view.renderer, state, connection),
  )
  async function settle() {
    await Bun.sleep(5)
    await view.renderOnce()
    return view.captureCharFrame()
  }
  async function sent() {
    for (let attempt = 0; attempt < 100 && state.modal; attempt++) await settle()
    expect(state.modal).toBeUndefined()
  }
  const picker = () => state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  const input = () => state.modal!.fields.find((field) => field instanceof InputRenderable) as InputRenderable
  const enter = async () => {
    view.mockInput.pressEnter()
    return settle()
  }
  const arrow = async (direction: "up" | "down" | "left" | "right") => {
    view.mockInput.pressArrow(direction)
    return settle()
  }
  const ctrlS = async () => {
    view.mockInput.pressKey("s", { ctrl: true })
    return settle()
  }
  const space = async () => {
    view.mockInput.pressKey(" ")
    return settle()
  }
  requests.question()
  await settle()
  return { view, state, dialogs, requests, posts, settle, sent, picker, input, enter, arrow, ctrlS, space }
}
