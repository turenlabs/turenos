import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen, type Route } from "./support"

async function sized(width: number, height: number, routes: Record<string, Route> = {}) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  /** Runs a Ctrl+P palette action by name. */
  async function palette(name: string) {
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText(name)
    view.mockInput.pressEnter()
  }
  return { view, screen, palette }
}

const rows = (frame: string) => frame.split("\n").map((line) => line.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").trimEnd())
const after = (frame: string, text: string) => rows(frame)[rows(frame).findIndex((line) => line.includes(text)) + 1]!

const message = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } })
const history = {
  "GET /api/session/ses_main/message": () => ({
    data: [message("msg_a", "Latest real prompt", 2), message("msg_b", "First prompt", 1)],
    cursor: {},
  }),
}
const question: Record<string, Route> = {
  "GET /api/session/ses_main/question": () => ({
    data: [
      {
        id: "que_1",
        sessionID: "ses_main",
        questions: [
          {
            header: "Colour",
            question: "Which colour?",
            custom: true,
            options: [
              { label: "Red", description: "A warm colour" },
              { label: "Blue", description: "A cool colour" },
            ],
          },
        ],
      },
    ],
  }),
}

test("the typed confirmation is a boxed field with no placeholder that reads as the typed word", async () => {
  const { view, screen, palette } = await sized(100, 36, history)
  await screen("main task")
  await palette("Undo conversation turn")
  const frame = await screen("Confirmation (type undo)")
  expect(after(frame, "Confirmation (type undo)")).toMatch(/^\[ +\]$/)
  await view.mockInput.typeText("und")
  await view.renderOnce()
  expect(after(view.captureCharFrame(), "Confirmation (type undo)")).toMatch(/^\[ und +\]$/)
})

test("the custom answer is a boxed field whose placeholder is not its label", async () => {
  const { view, screen } = await sized(100, 36, question)
  await screen("Which colour?")
  view.mockInput.pressKey("3")
  view.mockInput.pressEnter()
  const frame = await screen("Save custom answer")
  expect(after(frame, "Your answer").trim()).toMatch(/^\[ Type your answer +\]$/)
})

test("the new-terminal title is a boxed field", async () => {
  const { view, screen } = await sized(100, 36)
  view.mockInput.pressKey("2")
  await screen("No terminals")
  view.mockInput.pressKey("a")
  const frame = await screen("New terminal")
  expect(after(frame, "Title (optional")).toMatch(/^\[ +\]$/)
})

test("undo marks only the focused field with an arrow, and the chosen file mode with a radio", async () => {
  const { view, screen, palette } = await sized(100, 36, history)
  await screen("main task")
  await palette("Undo conversation turn")
  const frame = await screen("Confirmation (type undo)")
  const arrows = (text: string) => rows(text).filter((line) => line.includes("▶"))
  expect(arrows(frame)).toEqual(["▶ Confirmation (type undo)"])
  expect(frame).toContain("(•) Conversation only")
  view.mockInput.pressTab()
  await view.renderOnce()
  const moved = view.captureCharFrame()
  expect(arrows(moved)).toEqual(["▶ File mode (↑/↓ choose)"])
  view.mockInput.pressArrow("down")
  await view.renderOnce()
  const chosen = view.captureCharFrame()
  expect(chosen).toContain("( ) Conversation only")
  expect(chosen).toContain("(•) Conversation + files")
  expect(arrows(chosen)).toEqual(["▶ File mode (↑/↓ choose)"])
})

test("a rewound prompt's footer says Ctrl+S rewind, and an undo's says Ctrl+S undo", async () => {
  const { view, screen } = await sized(100, 36, { ...history, ...commands() })
  await screen("main task")
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/rewind")
  await screen("/rewind")
  view.mockInput.pressEnter()
  await screen("▶ Latest real prompt")
  view.mockInput.pressEnter()
  const frame = await screen("Confirmation (type undo)")
  expect(frame).toContain("Rewind conversation?")
  expect(frame).toContain("Ctrl+S rewind · Enter does not confirm")
})

test("an undo's footer says Ctrl+S undo", async () => {
  const { screen, palette } = await sized(100, 36, history)
  await screen("main task")
  await palette("Undo conversation turn")
  expect(await screen("Ctrl+S undo · Enter does not confirm")).not.toContain("Ctrl+S rewind")
})

function commands() {
  return {
    "GET /api/command": () => ({
      location: { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } },
      data: [],
    }),
  }
}

for (const height of [24, 36]) {
  test(`a question's key hints keep every entry whole at 60x${height}`, async () => {
    const { screen } = await sized(60, height, question)
    const frame = await screen("Which colour?")
    expect(frame).toContain("Ctrl+R Reject request")
    expect(frame).toContain("Esc close")
    expect(frame).toContain("Enter Choose, then review answers")
  })
}

test("stop all asks for its word once, as kill does", async () => {
  const { screen, palette } = await sized(100, 36)
  await screen("main task")
  await palette("Stop all agents")
  const frame = await screen("Confirmation (type stop all)")
  expect(frame).not.toContain("Type stop all, then")
  expect(rows(frame).filter((line) => line.includes("(type stop all)"))).toHaveLength(1)
})

test("New session settings all fit at 80x24 and Tab walks them in view", async () => {
  const { view, screen } = await sized(80, 24, {
    "GET /api/agent": () => ({
      location: { directory: "/srv/main" },
      data: [
        { id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] },
        { id: "plan", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] },
      ],
    }),
  })
  view.mockInput.pressKey("n", { ctrl: true })
  await screen("What would you like to do?")
  view.mockInput.pressTab()
  await screen("▶ Directory on the server")
  const frame = await screen("Server default")
  const shown = ["Agent ·", "Server default", "Model ·", "Workspace ·", "This folder", "New git worktree"]
  for (const text of [...shown, "[ Send (Enter) ]"]) expect(frame).toContain(text)
  expect(frame).not.toContain("█")
  for (const caption of ["Agent", "Model", "Workspace"]) {
    view.mockInput.pressTab()
    await view.renderOnce()
    const next = view.captureCharFrame()
    expect(next).toContain(`▶ ${caption}`)
    expect(next).toContain("New git worktree")
    expect(next).toContain("[ Send (Enter) ]")
  }
})
