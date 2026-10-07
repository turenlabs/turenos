import { afterEach, expect, test } from "bun:test"
import { InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createRequests } from "../src/requests"
import { connect, type Detail } from "../src/server"
import { createSlashCommands } from "../src/slash"
import { createMentions } from "../src/mentions"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

const single = {
  header: "Approach",
  question: "Which approach should we use?",
  custom: false,
  options: [
    { label: "Small change", description: "Keep the existing design." },
    { label: "New design", description: "Replace the current design." },
  ],
}

async function fixture(questions: Detail["questions"][number]["questions"], width = 100, height = 36) {
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

test("single picker needs answers and review; final payload keeps captured IDs and labels", async () => {
  const f = await fixture([single, { ...single, header: "Second", question: "And the second choice?" }])
  expect(f.posts).toEqual([])
  await f.ctrlS()
  expect(f.posts).toEqual([])
  expect(f.state.modal!.error.plainText).toContain("Answer every question")
  await expect(f.state.modal!.submit!()).rejects.toThrow("review")
  await f.arrow("down")
  expect(f.picker().getSelectedIndex()).toBe(1)
  expect(await f.enter()).toContain("Question 2 of 2")
  await f.ctrlS()
  expect(f.posts).toEqual([])
  expect(await f.enter()).toContain("Review answers")
  expect(f.posts).toEqual([])
  await f.arrow("left")
  expect(f.picker().options[0]!.name).toContain("[x]")
  await f.arrow("left")
  expect(f.picker().getSelectedIndex()).toBe(1)
  expect(f.picker().options[1]!.name).toContain("[x]")
  // Even with all answers filled, Ctrl+S only opens review on its first use.
  expect(await f.ctrlS()).toContain("Review answers")
  expect(f.posts).toEqual([])
  f.state.selected = "ses_elsewhere"
  f.state.detail = undefined
  await f.ctrlS()
  await f.sent()
  expect(f.posts).toEqual([
    {
      path: "/api/session/ses_question/question/que_picker/reply",
      body: JSON.stringify({ answers: [["New design"], ["Small change"]] }),
    },
  ])
})

test("clicking question text keeps arrow navigation in the option picker", async () => {
  const f = await fixture([single])
  const picker = f.picker()
  const rows = (await f.settle()).split("\n")
  const y = rows.findIndex((line) => line.includes(single.question))
  expect(y).toBeGreaterThanOrEqual(0)
  await f.view.mockMouse.click(rows[y]!.indexOf(single.question) + 1, y)
  expect(f.view.renderer.currentFocusedRenderable?.id).toBe(picker.id)
  await f.arrow("down")
  expect(picker.getSelectedIndex()).toBe(1)
  expect(f.posts).toEqual([])
})

test("multi-select, custom comma text, and backward navigation retain independent answers", async () => {
  const f = await fixture([{ ...single, multiple: true, custom: true }, single])
  await f.enter()
  expect(f.posts).toEqual([])
  expect(f.state.modal!.error.plainText).toContain("Choose an answer")
  await f.space()
  await f.arrow("down")
  await f.space()
  await f.space()
  expect(f.picker().options[0]!.name).toContain("[x]")
  expect(f.picker().options[1]!.name).toContain("[ ]")
  await f.arrow("down")
  await f.enter()
  expect(f.input().focused).toBe(true)
  await f.view.mockInput.typeText("Alpha, beta")
  await f.settle()
  await f.ctrlS()
  expect(f.posts).toEqual([])
  expect(f.state.modal!.error.plainText).toContain("save your custom")
  await f.enter()
  expect(await f.enter()).toContain("Question 2 of 2")
  await f.arrow("left")
  expect(f.picker().options[0]!.name).toContain("[x]")
  expect(f.picker().options[2]!.name).toContain("[x]")
  await f.space() // Remove custom without deleting its saved text.
  expect(f.picker().options[2]!.name).toContain("[ ]")
  await f.enter()
  expect(f.input().value).toBe("Alpha, beta")
  await f.enter()
  await f.arrow("right")
  expect(await f.enter()).toContain("Review answers")
  expect(f.posts).toEqual([])
  await f.enter()
  await f.sent()
  expect(JSON.parse(f.posts[0]!.body)).toEqual({ answers: [["Small change", "Alpha, beta"], ["Small change"]] })
})

test("custom-only single answer stays intact and blank custom input cannot advance", async () => {
  const f = await fixture([{ header: "Details", question: "What else?", options: [] }])
  await f.enter()
  await f.enter()
  expect(f.state.modal!.error.plainText).toContain("non-empty")
  expect(f.posts).toEqual([])
  await f.view.mockInput.typeText("one, two, three")
  await f.settle()
  expect(await f.enter()).toContain("Review answers")
  expect(f.posts).toEqual([])
  await f.ctrlS()
  await f.sent()
  expect(JSON.parse(f.posts[0]!.body)).toEqual({ answers: [["one, two, three"]] })
})

test("custom drafts survive returning to choices; Ctrl+Enter and Escape cannot send them", async () => {
  const f = await fixture([{ ...single, custom: true }])
  f.view.mockInput.pressKey("enter", { ctrl: true })
  await f.settle()
  expect(f.posts).toEqual([])
  await f.arrow("down")
  await f.arrow("down")
  await f.enter()
  await f.view.mockInput.typeText("Draft, not sent")
  f.view.mockInput.pressKey("b", { ctrl: true })
  await f.settle()
  expect(f.picker().options[2]!.name).toContain("[ ]")
  await f.enter()
  expect(f.input().value).toBe("Draft, not sent")
  f.view.mockInput.pressKey("enter", { ctrl: true })
  await f.settle()
  expect(f.posts).toEqual([])
  f.view.mockInput.pressKey("ESCAPE")
  await f.settle()
  expect(f.state.modal).toBeUndefined()
  expect(f.posts).toEqual([])
})

test("Escape never sends; rejection requires deliberate mode and confirmation", async () => {
  const f = await fixture([single])
  expect(f.picker().options).toHaveLength(2) // custom:false
  f.view.mockInput.pressKey("r", { ctrl: true })
  expect(await f.settle()).toContain("Reject question request?")
  await f.enter()
  expect(f.posts).toEqual([])
  // Esc leaves the confirmation for the question it came from; a second Esc closes the dialog.
  f.view.mockInput.pressKey("ESCAPE")
  expect(await f.settle()).not.toContain("Reject question request?")
  expect(f.state.modal).toBeDefined()
  f.view.mockInput.pressKey("ESCAPE")
  await f.settle()
  expect(f.state.modal).toBeUndefined()
  expect(f.posts).toEqual([])
  f.requests.question(true)
  await f.settle()
  expect(f.posts).toEqual([])
  await f.ctrlS()
  await f.sent()
  expect(f.posts).toEqual([{ path: "/api/session/ses_question/question/que_picker/reject", body: "" }])
  f.requests.question()
  await f.settle()
  await f.enter()
  f.view.mockInput.pressKey("ESCAPE")
  await f.settle()
  expect(f.posts).toHaveLength(1)
})

test("question navigation preserves rejection mode and uncommitted custom text", async () => {
  const f = await fixture([{ ...single, custom: true }])
  await f.arrow("down")
  await f.arrow("down")
  await f.enter()
  await f.view.mockInput.typeText("unsent, custom")
  expect(f.dialogs.navigate()).toBe(true)
  f.requests.offerInput()
  await f.settle()
  expect(f.input().value).toBe("unsent, custom")
  f.view.mockInput.pressKey("r", { ctrl: true })
  await f.settle()
  expect(f.dialogs.navigate()).toBe(true)
  f.requests.offerInput()
  expect(await f.settle()).toContain("Reject question request?")
  expect(f.posts).toEqual([])
})

test("changed question content does not reuse an old review or choices", async () => {
  const f = await fixture([single])
  expect(await f.enter()).toContain("Review answers")
  expect(f.dialogs.navigate()).toBe(true)
  f.state.detail = {
    ...f.state.detail!,
    questions: [
      {
        ...f.state.detail!.questions[0]!,
        questions: [
          {
            ...single,
            question: "A different decision?",
            options: [{ label: "Different", description: "New choice" }],
          },
        ],
      },
    ],
  }
  f.requests.offerInput()
  expect(await f.settle()).toContain("Question 1 of 1")
  expect(f.picker().options[0]!.name).toContain("[ ]")
  expect(f.posts).toEqual([])
})

for (const [width, height] of [
  [60, 24],
  [120, 36],
] as const) {
  test(`question picker fits ${width}x${height} and wraps prompt and focused description`, async () => {
    const f = await fixture(
      [
        {
          ...single,
          question:
            "Choose the implementation approach that preserves existing behavior while making the interface easier to use.",
          options: [
            {
              label: "Small change",
              description:
                "Keep the existing design and preserve every established interaction while improving the question picker.",
            },
          ],
        },
      ],
      width,
      height,
    )
    const modal = f.state.modal!
    expect(modal.frame.x).toBeGreaterThanOrEqual(0)
    expect(modal.frame.y).toBeGreaterThanOrEqual(0)
    expect(modal.frame.x + modal.frame.width).toBeLessThanOrEqual(width)
    expect(modal.frame.y + modal.frame.height).toBeLessThanOrEqual(height)
    expect(modal.error.y + modal.error.height).toBeLessThanOrEqual(height)
    const texts = modal.form.getChildren().filter((node) => node instanceof TextRenderable)
    const prompt = texts.find((node) => node.plainText.startsWith("Choose the implementation"))!
    const description = texts.find((node) => node.plainText.includes("preserve every established"))!
    expect(prompt.height).toBeGreaterThan(1)
    expect(description.height).toBeGreaterThan(1)
    expect(f.picker().height).toBeLessThanOrEqual(4)
    expect(await f.settle()).toContain("Esc close")
    expect(f.posts).toEqual([])
  })
}

test("a single-choice footer says where Enter goes, and a page shows its choice when revisited", async () => {
  const f = await fixture([single, { ...single, header: "Second", question: "And the second choice?" }])
  expect(await f.settle()).toContain("Enter Choose, then next question")
  await f.arrow("down")
  const second = await f.enter()
  expect(second).toContain("Question 2 of 2")
  expect(second).toContain("Enter Choose, then review answers")
  expect(f.posts).toEqual([])
  await f.arrow("left")
  const revisited = await f.settle()
  expect(revisited).toContain("[x] New design")
  expect(revisited).toContain("[ ] Small change")
  expect(f.posts).toEqual([])
})

test("one Enter on the only question chooses it and opens the review; nothing is sent until submit", async () => {
  const f = await fixture([single])
  expect(await f.settle()).toContain("Enter Choose, then review answers")
  const review = await f.enter()
  expect(review).toContain("Review answers")
  expect(review).toContain("Small change")
  expect(f.posts).toEqual([])
})

test("digits highlight a single choice and toggle a multi choice without ever submitting", async () => {
  const single2 = await fixture([single])
  expect(single2.state.modal!.error.plainText).toContain("1-9")
  single2.view.mockInput.pressKey("2")
  await single2.settle()
  expect(single2.picker().getSelectedIndex()).toBe(1)
  expect(single2.picker().options[1]!.name).toContain("[ ]")
  single2.view.mockInput.pressKey("9")
  await single2.settle()
  expect(single2.picker().getSelectedIndex()).toBe(1)
  expect(single2.posts).toEqual([])

  const multi = await fixture([{ ...single, multiple: true }])
  multi.view.mockInput.pressKey("2")
  await multi.settle()
  expect(multi.picker().options[1]!.name).toContain("[x]")
  expect(multi.picker().options[0]!.name).toContain("[ ]")
  multi.view.mockInput.pressKey("2")
  await multi.settle()
  expect(multi.picker().options[1]!.name).toContain("[ ]")
  expect(multi.posts).toEqual([])
})

test("sweeping drops the drafts of requests that are no longer pending, custom text included", async () => {
  const { sweepDrafts } = await import("../src/requests/question/draft")
  const f = await fixture([{ ...single, custom: true }])
  await f.arrow("down")
  await f.arrow("down")
  await f.enter()
  await f.view.mockInput.typeText("private text")
  f.view.mockInput.pressEscape()
  await f.settle()
  const drafts = new Map([
    ["ses_question:que_gone", { custom: ["private text"] }],
    ["ses_question:que_picker", { custom: [""] }],
    ["ses_other:que_other", { custom: [""] }],
  ]) as unknown as Parameters<typeof sweepDrafts>[1]
  sweepDrafts(f.state, drafts)
  expect([...drafts.keys()]).toEqual(["ses_question:que_picker", "ses_other:que_other"])
})
