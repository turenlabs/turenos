import { afterEach, expect, test } from "bun:test"
import { focusSessionRequestOption } from "./session-request-focus"

afterEach(() => document.body.replaceChildren())

function request() {
  const root = document.createElement("div")
  const target = document.createElement("button")
  root.append(target)
  document.body.append(root)
  return { root, target }
}

test("a question arriving while composing preserves the draft, selection, and focus", () => {
  const editor = document.createElement("textarea")
  editor.value = "Use the existing service instead"
  document.body.append(editor)
  editor.focus()
  editor.setSelectionRange(4, 12)
  focusSessionRequestOption({ ...request(), initial: true })

  expect(document.activeElement).toBe(editor)
  expect(editor.value).toBe("Use the existing service instead")
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 12])
})

test("initial request focus preserves another focused control", () => {
  const button = document.createElement("button")
  document.body.append(button)
  button.focus()
  focusSessionRequestOption({ ...request(), initial: true })
  expect(document.activeElement).toBe(button)
})

test("an initial request offers keyboard focus when no control owns it", () => {
  const input = request()
  focusSessionRequestOption({ ...input, initial: true })
  expect(document.activeElement).toBe(input.target)
})

test("explicit option navigation and restoring a minimized question still focus the request", () => {
  const editor = document.createElement("textarea")
  document.body.append(editor)
  editor.focus()
  const input = request()
  focusSessionRequestOption(input)
  expect(document.activeElement).toBe(input.target)
})
