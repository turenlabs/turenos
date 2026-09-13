import { describe, expect, test } from "bun:test"
import { patchFiles } from "./apply-patch-file"
import { text } from "./session-diff"

describe("apply patch file", () => {
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })

  test("parses the V2 FileDiff.Info shape (file + status)", () => {
    const file = patchFiles([
      {
        file: "a.ts",
        status: "modified",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.type).toBe("update")
    expect(file?.relativePath).toBe("a.ts")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("maps V2 added and deleted statuses to add and delete", () => {
    const files = patchFiles([
      { file: "new.ts", status: "added", patch: "x", additions: 3, deletions: 0 },
      { file: "gone.ts", status: "deleted", patch: "x", additions: 0, deletions: 4 },
    ])
    expect(files.map((f) => f.type)).toEqual(["add", "delete"])
  })
})
