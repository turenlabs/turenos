import { expect, test } from "bun:test"
import { changeSummary, diffLines, fileLabel, type RevertFile } from "../src/diff"
import { color } from "../src/theme"

function file(overrides: Partial<RevertFile> = {}): RevertFile {
  return {
    path: "src/auth.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1,3 +1,4 @@\n context\n-gone\n+added\n+also added\n",
    ...overrides,
  }
}

test("the summary totals the staged changes and distinguishes a combined diff", () => {
  expect(changeSummary(undefined)).toBe("")
  expect(changeSummary({ messageID: "msg_a" })).toBe("")
  expect(changeSummary({ messageID: "msg_a", files: [file()] })).toBe("1 file · +2 -1")
  expect(changeSummary({ messageID: "msg_a", files: [file(), file({ additions: 10, deletions: 4 })] })).toBe(
    "2 files · +12 -5",
  )
  // A server that sends only a combined diff still has to warn that files change.
  expect(changeSummary({ messageID: "msg_a", diff: "--- a\n+++ b\n" })).toContain("no per-file detail")
})

test("file labels carry status and counts without letting a path break the row", () => {
  expect(fileLabel(file())).toBe("M src/auth.ts  +2 -1")
  expect(fileLabel(file({ status: "added", path: "a.ts", additions: 9, deletions: 0 }))).toBe("A a.ts  +9 -0")
  expect(fileLabel(file({ status: "deleted", path: "b.ts" }))).toStartWith("D b.ts")
  expect(fileLabel(file({ path: "a\nb\u001b[31m.ts" }))).toBe("M a b[31m.ts  +2 -1")
})

test("patch lines are classified, with headers never mistaken for additions or removals", () => {
  const lines = diffLines({ messageID: "msg_a", files: [file()] })
  expect(lines[0]).toEqual({ text: "M src/auth.ts  +2 -1", tone: "meta" })
  expect(lines.slice(1, 6)).toEqual([
    { text: "@@ -1,3 +1,4 @@", tone: "meta" },
    { text: " context", tone: "context" },
    { text: "-gone", tone: "removed" },
    { text: "+added", tone: "added" },
    { text: "+also added", tone: "added" },
  ])
  const headers = diffLines({
    messageID: "msg_a",
    files: [file({ patch: "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n+real\n-real\n" })],
  })
  expect(headers.filter((line) => line.tone === "added").map((line) => line.text)).toEqual(["+real"])
  expect(headers.filter((line) => line.tone === "removed").map((line) => line.text)).toEqual(["-real"])
})

test("untrusted patch text cannot emit terminal controls or span extra rows", () => {
  const lines = diffLines({
    messageID: "msg_a",
    files: [file({ patch: `+\u001b[2J\u0007evil\n+${"x".repeat(4000)}\n` })],
  })
  for (const line of lines) {
    expect(line.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(line.text).not.toContain("\n")
  }
  expect(lines.some((line) => line.text.includes("[2Jevil"))).toBe(true)
  expect(lines.some((line) => line.text.includes("[display shortened]"))).toBe(true)
})

test("a very large revert is bounded and says so instead of stalling the dialog", () => {
  const many = Array.from({ length: 80 }, (_, index) => file({ path: `src/f${index}.ts` }))
  const lines = diffLines({ messageID: "msg_a", files: many })
  expect(lines.length).toBeLessThanOrEqual(602)
  expect(lines.some((line) => line.text === "[30 more file(s) not shown]")).toBe(true)

  const long = file({ patch: Array.from({ length: 400 }, (_, index) => `+line ${index}`).join("\n") })
  const capped = diffLines({ messageID: "msg_a", files: [long] })
  expect(capped.filter((line) => line.tone === "added")).toHaveLength(120)
  expect(capped.some((line) => line.text === "[280 more patch line(s)]")).toBe(true)
})

test("the diff tones stay readable on the surfaces the confirmation renders on", () => {
  const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((offset) => channel(parseInt(hex.slice(offset, offset + 2), 16) / 255))
    return r! * 0.2126 + g! * 0.7152 + b! * 0.0722
  }
  const contrast = (a: string, b: string) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
  for (const token of [color.added, color.removed] as const) {
    for (const background of [color.bg, color.panel] as const) {
      expect(contrast(token, background)).toBeGreaterThanOrEqual(4.5)
    }
  }
  // Additions and removals must not be told apart by position alone.
  expect(color.added).not.toBe(color.removed)
})
