import { expect, test } from "bun:test"
import { create } from "../src/identifier"

test("creates fixed-width sortable identifiers", () => {
  const firstAscending = create(false, 1)
  const secondAscending = create(false, 1)
  const firstDescending = create(true, 2)
  const secondDescending = create(true, 2)

  expect(firstAscending).toHaveLength(26)
  expect(firstAscending.slice(0, 12)).toBe("000000001001")
  expect(firstAscending.slice(12)).toMatch(/^[0-9A-Za-z]{14}$/)
  expect(firstAscending.slice(0, 12) < secondAscending.slice(0, 12)).toBe(true)

  expect(firstDescending).toHaveLength(26)
  expect(firstDescending.slice(0, 12)).toBe("ffffffffdffe")
  expect(firstDescending.slice(12)).toMatch(/^[0-9A-Za-z]{14}$/)
  expect(firstDescending.slice(0, 12) > secondDescending.slice(0, 12)).toBe(true)
})
