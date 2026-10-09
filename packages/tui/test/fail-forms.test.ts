import { expect, test } from "bun:test"
import { frameLines, sized, type Route } from "./support"

const after = (frame: string, text: string) => frameLines(frame)[frameLines(frame).findIndex((line) => line.includes(text)) + 1]!

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
  const frame = await screen("save custom answer")
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
  const arrows = (text: string) => frameLines(text).filter((line) => line.includes("▶"))
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
  const frame = await screen("Confirmation (type rewind)")
  expect(frame).not.toContain("type undo")
  expect(frame).toContain("Rewind conversation?")
  expect(frame).toContain("Enter or Ctrl+S rewind")
})

test("an undo's footer says Ctrl+S undo", async () => {
  const { screen, palette } = await sized(100, 36, history)
  await screen("main task")
  await palette("Undo conversation turn")
  expect(await screen("Enter or Ctrl+S undo")).not.toContain("Ctrl+S rewind")
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
    expect(frame).toContain("Ctrl+R reject request")
    expect(frame).toContain("Esc close")
    expect(frame).toContain("Enter choose, then review answers")
  })
}

test("stop all asks for its word once, as kill does", async () => {
  const { screen, palette } = await sized(100, 36)
  await screen("main task")
  await palette("Stop all agents")
  const frame = await screen("Confirmation (type stop all)")
  expect(frame).not.toContain("Type stop all, then")
  expect(frameLines(frame).filter((line) => line.includes("(type stop all)"))).toHaveLength(1)
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
