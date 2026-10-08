import { expect, test } from "bun:test"
import { entryList, type Entry } from "../src/files/entries"

test("file listings preserve literal POSIX backslashes instead of selecting another file", () => {
  const files = ["report\\", "report\\\\", "report", "notes\\draft.txt"].map(
    (path): Entry => ({
      name: path,
      path,
      type: "file",
      ignored: false,
    }),
  )
  expect(entryList(files)).toEqual(files)
})

test("folder listings remove only the one separator the server appends", () => {
  const paths = ["notes/", "notes\\/", "notes\\\\/", "src\\notes\\"]
  expect(
    entryList(paths.map((path) => ({ name: "notes", path, type: "directory" }))).map((entry) => entry.path),
  ).toEqual(["notes", "notes\\", "notes\\\\", "src\\notes"])
})
