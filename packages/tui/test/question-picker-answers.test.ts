import { expect, test } from "bun:test"
import { single, fixture } from "./question-picker-fixture"

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
  expect(f.picker().options[0]!.name).toContain("(•)")
  await f.arrow("left")
  expect(f.picker().getSelectedIndex()).toBe(1)
  expect(f.picker().options[1]!.name).toContain("(•)")
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

test("Tab and Shift+Tab move between questions like the arrows; a custom answer keeps Tab for its fields", async () => {
  const f = await fixture([single, { ...single, header: "Second", question: "And the second choice?", custom: true }])
  const tab = async (shift = false) => {
    f.view.mockInput.pressTab({ shift })
    return f.settle()
  }
  expect(await f.enter()).toContain("Question 2 of 2")
  expect(await tab(true)).toContain("Question 1 of 2")
  expect(await tab()).toContain("Question 2 of 2")
  expect(f.posts).toEqual([])
  await f.arrow("down")
  await f.arrow("down")
  expect(await f.enter()).toContain("Your answer")
  // Typing a custom answer: Tab goes back to the choices on the same question.
  expect(await tab()).toContain("Question 2 of 2")
  expect(f.picker().focused).toBe(true)
  expect(f.posts).toEqual([])
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
  expect(f.picker().options[2]!.name).toContain("( )")
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
  expect(f.picker().options[0]!.name).toContain("( )")
  expect(f.posts).toEqual([])
})
