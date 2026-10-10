import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { assistant, cleanup, session, terminal, turen, until, type Route } from "./support"

const user = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id: `msg_${id}`,
  type: "user",
  time: { created: 1 },
  text,
  ...extra,
})

async function open(routes: Record<string, Route>, options: { session?: string } = {}) {
  const server = turen({ routes })
  const { view, screen } = await terminal(120, 36, true)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, () => {}, options)
  cleanup.push(app.dispose)
  await app.ready
  return { server, view, screen, editor: () => view.renderer.currentFocusedEditor }
}

const prompts = {
  "GET /api/session/ses_main/message": () => ({
    // The server lists newest first.
    data: [
      user("three", "third prompt"),
      user("note", "agent note", { source: "subagent_board" }),
      user("two", "second prompt"),
      assistant("a", "ok"),
      user("one", "first prompt"),
    ],
    cursor: {},
  }),
}

test("Up walks back through earlier prompts, Down returns to the empty editor, and nothing is sent", async () => {
  const { server, view, screen, editor } = await open(prompts)
  await screen("Focus: sidebar")
  view.mockInput.pressEnter()
  await screen("Typing")
  await screen("third prompt")
  const up = async (text: string) => {
    view.mockInput.pressArrow("up")
    await until(() => editor()?.plainText === text)
  }
  const down = async (text: string) => {
    view.mockInput.pressArrow("down")
    await until(() => editor()?.plainText === text)
  }
  await up("third prompt")
  await up("second prompt")
  await up("first prompt")
  view.mockInput.pressArrow("up")
  await view.renderOnce()
  expect(editor()?.plainText).toBe("first prompt")
  await down("second prompt")
  await down("third prompt")
  await down("")
  view.mockInput.pressArrow("down")
  await view.renderOnce()
  expect(editor()?.plainText).toBe("")
  expect(server.requests.filter((request) => request.method === "POST")).toEqual([])
})

test("an edit during the walk ends it and the arrows stop recalling", async () => {
  const { view, screen, editor } = await open(prompts)
  await screen("Focus: sidebar")
  view.mockInput.pressEnter()
  await screen("Typing")
  await screen("third prompt")
  view.mockInput.pressArrow("up")
  await until(() => editor()?.plainText === "third prompt")
  view.mockInput.pressArrow("up")
  await until(() => editor()?.plainText === "second prompt")
  await view.mockInput.typeText("!")
  await until(() => editor()?.plainText.includes("!") === true)
  const edited = editor()!.plainText
  view.mockInput.pressArrow("up")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("up")
  await view.renderOnce()
  expect(editor()?.plainText).toBe(edited)
})

test("Up does not start a walk over typed text or a multi-line draft", async () => {
  const { view, screen, editor } = await open(prompts)
  await screen("Focus: sidebar")
  view.mockInput.pressEnter()
  await screen("Typing")
  await screen("third prompt")
  await view.mockInput.typeText("draft")
  view.mockInput.pressArrow("up")
  await view.renderOnce()
  expect(editor()?.plainText).toBe("draft")
  editor()!.insertText("\n")
  await view.mockInput.typeText("line two")
  await until(() => editor()?.plainText === "draft\nline two")
  view.mockInput.pressArrow("up")
  view.mockInput.pressArrow("up")
  await view.renderOnce()
  expect(editor()?.plainText).toBe("draft\nline two")
})

const other = {
  "GET /api/session": () => ({ data: [session("main"), session("other")], cursor: {} }),
  "GET /api/session/ses_other": () => ({ data: session("other") }),
  "GET /api/session/ses_other/message": () => ({ data: [assistant("other", "other says hello")], cursor: {} }),
  "GET /api/session/ses_other/task": () => ({ data: [], active: [], cursor: {} }),
  "GET /api/session/ses_other/permission": () => ({ data: [] }),
  "GET /api/session/ses_other/question": () => ({ data: [] }),
  "GET /api/session/ses_other/input": () => ({ data: [] }),
}

test("a dashboard mounted with a session option selects it when the snapshot holds it", async () => {
  const { screen } = await open(other, { session: "ses_other" })
  await screen("other says hello")
})

test("a requested session the server does not have says so and keeps the normal choice", async () => {
  const { screen } = await open({}, { session: "ses_gone" })
  await screen("No session ses_gone")
  await screen("main says hello")
})

test("a requested session missing from the snapshot is fetched and opened", async () => {
  const { screen } = await open(
    { ...other, "GET /api/session": () => ({ data: [session("main")], cursor: {} }) },
    { session: "ses_other" },
  )
  await screen("other says hello")
})
