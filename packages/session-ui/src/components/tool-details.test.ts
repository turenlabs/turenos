import { expect, test } from "bun:test"
import { toolDetailPage } from "./tool-details"

test("large raw results remain fully inspectable without rendering the entire result at once", () => {
  const value = "A".repeat(16_000) + "B".repeat(16_000) + "last result"
  const pages = Array.from({ length: toolDetailPage(value, 0).pages }, (_, index) => toolDetailPage(value, index))
  expect(pages.every((page) => page.text.length <= 16_000)).toBe(true)
  expect(pages.map((page) => page.text).join("")).toBe(value)
  expect(pages[2]?.text).toBe("last result")
})

test("replacing a long result while viewing its last page clamps to the available content", () => {
  expect(toolDetailPage("replacement", 200)).toEqual({ page: 0, pages: 1, text: "replacement" })
  expect(toolDetailPage("", 1)).toEqual({ page: 0, pages: 1, text: "" })
})
