import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { single, fixture } from "./question-picker-fixture"

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

test("a single-choice footer names the key that selects, and a page shows its choice when revisited", async () => {
  const f = await fixture([single, { ...single, header: "Second", question: "And the second choice?" }])
  expect(await f.settle()).toContain("1-9 move · Enter select")
  await f.arrow("down")
  const second = await f.enter()
  expect(second).toContain("Question 2 of 2")
  expect(second).toContain("1-9 move · Enter select")
  expect(f.posts).toEqual([])
  await f.arrow("left")
  const revisited = await f.settle()
  expect(revisited).toContain("(•) New design")
  expect(revisited).toContain("( ) Small change")
  expect(f.posts).toEqual([])
})

test("one Enter on the only question chooses it and opens the review; nothing is sent until submit", async () => {
  const f = await fixture([single])
  expect(await f.settle()).toContain("1-9 move · Enter select")
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
  expect(single2.picker().options[1]!.name).toContain("( )")
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
