import { expect, test } from "bun:test"
import { stamp } from "../src/menus/stamp"
import { sessionTitle } from "../src/state"

test("a server placeholder title reads as a local `YYYY-MM-DD HH:MM` stamp", () => {
  const title = sessionTitle("New session - 2026-10-07T17:32:46.744Z")
  expect(title).toMatch(/^New session · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  expect(title).toBe(`New session · ${stamp(Date.parse("2026-10-07T17:32:46.744Z"))}`)
})

test("a child session placeholder reads the same way", () => {
  expect(sessionTitle("Child session - 2026-10-07T17:32:46.744Z")).toBe(
    `Child session · ${stamp(Date.parse("2026-10-07T17:32:46.744Z"))}`,
  )
})

test("any other title is only sanitized and cut", () => {
  expect(sessionTitle("please run the marker")).toBe("please run the marker")
  expect(sessionTitle("New session - not a time")).toBe("New session - not a time")
  expect(sessionTitle("New session - 2026-13-45T99:99:99Z")).toBe("New session - 2026-13-45T99:99:99Z")
  expect(sessionTitle("Child session - 2026-13-45T99:99:99.000Z")).toBe("Child session - 2026-13-45T99:99:99.000Z")
  expect(sessionTitle("New session - 2026-10-07T17:32:46Z")).toBe("New session - 2026-10-07T17:32:46Z")
  expect(sessionTitle("a\tb\nc")).toBe("a b c")
  expect(sessionTitle("abcdef", 4)).toBe("abc…")
})
