import { beforeAll, describe, expect, test } from "bun:test"
import { applyPatch, createTwoFilesPatch, diffLines, parsePatch } from "diff"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "./fixture/tmpdir"

// Differential tests of tools/text-diff against the implementations it must agree with: the `diff` package
// (the patch format and line counts the edit tools use today) and `git diff --numstat`. The WASM is the real
// packaged artifact. `applyPatch` is the independent oracle for "this patch is valid": it never saw the Rust.

type Result = {
  binary: boolean
  additions: number
  deletions: number
  approximate: boolean
  lossy: boolean
  patchTruncated: boolean
  patch?: string
  error?: string
}

let diffText: (before: Uint8Array, after: Uint8Array, options: string) => string
const encoder = new TextEncoder()
const run = (before: string, after: string, options: object = {}) =>
  JSON.parse(diffText(encoder.encode(before), encoder.encode(after), JSON.stringify(options))) as Result

beforeAll(async () => {
  const root = path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/text-diff-wasm")))
  const api = await import(path.join(root, "turen_text_diff_wasm.js"))
  await api.default({ module_or_path: await readFile(path.join(root, "turen_text_diff_wasm_bg.wasm")) })
  diffText = api.diff_text
})

// mulberry32: a fixed seed keeps every failure reproducible.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** A random file: `unique` gives every line distinct text; otherwise lines repeat, which makes diffs ambiguous. */
const file = (next: () => number, unique: boolean) => {
  const eol = next() < 0.15 ? "\r\n" : "\n"
  const lines = Array.from({ length: Math.floor(next() * 60) }, (_, index) =>
    unique ? `line ${index} ${Math.floor(next() * 1e9)}` : ["", "}", "  return x", "foo()", "// note", `v${Math.floor(next() * 4)}`][Math.floor(next() * 6)]!,
  )
  const trailing = next() < 0.8
  return lines.join(eol) + (lines.length > 0 && trailing ? eol : "")
}

/** Edits a file the way an agent would: replace, insert and delete a few lines, sometimes dropping the final newline. */
const edit = (next: () => number, before: string) => {
  const eol = before.includes("\r\n") ? "\r\n" : "\n"
  const lines = before.length === 0 ? [] : before.split(eol)
  const ended = before.endsWith(eol)
  if (ended) lines.pop()
  for (let change = 0; change < 1 + Math.floor(next() * 5); change++) {
    const at = Math.floor(next() * (lines.length + 1))
    const kind = next()
    if (kind < 0.4) lines.splice(at, 1, `changed ${Math.floor(next() * 1e9)}`)
    else if (kind < 0.7) lines.splice(at, 0, `inserted ${Math.floor(next() * 1e9)}`)
    else lines.splice(at, 1)
  }
  const keep = next() < 0.85 ? ended : !ended
  return lines.join(eol) + (lines.length > 0 && keep ? eol : "")
}

describe("text-diff wasm", () => {
  test("counts match jsdiff and the patch applies, for ambiguous and unambiguous files alike", () => {
    const next = random(1)
    let checked = 0
    for (let iteration = 0; iteration < 600; iteration++) {
      const before = file(next, iteration % 2 === 0)
      const after = edit(next, before)
      const result = run(before, after, { oldName: "f.txt", newName: "f.txt" })

      expect(result.approximate).toBe(false)
      const expected = diffLines(before, after).reduce(
        (total, part) => ({
          additions: total.additions + (part.added ? (part.count ?? 0) : 0),
          deletions: total.deletions + (part.removed ? (part.count ?? 0) : 0),
        }),
        { additions: 0, deletions: 0 },
      )
      expect([result.additions, result.deletions]).toEqual([expected.additions, expected.deletions])
      // jsdiff validates every hunk's counts against its body while parsing, then applying proves it is the edit.
      expect(parsePatch(result.patch!)).toHaveLength(1)
      expect(applyPatch(before, result.patch!)).toBe(after)
      checked++
    }
    expect(checked).toBe(600)
  })

  test("is byte-identical to createTwoFilesPatch whenever the diff is unambiguous", () => {
    // With every line distinct there is exactly one longest common subsequence, so Myers implementations must
    // agree. This is what pins the header, hunk addressing, ordering and no-newline marker to jsdiff's.
    const next = random(2)
    for (let iteration = 0; iteration < 400; iteration++) {
      const before = file(next, true)
      const after = edit(next, before)
      for (const [oldName, newName] of [["f.txt", "f.txt"], ["old.txt", "new.txt"]] as const) {
        for (const context of [0, 1, 4]) {
          expect(run(before, after, { oldName, newName, context }).patch).toBe(
            createTwoFilesPatch(oldName, newName, before, after, undefined, undefined, { context }),
          )
        }
      }
    }
  })

  test("agrees with git diff --numstat on line counts", async () => {
    await using dir = await tmpdir()
    const next = random(3)
    for (let iteration = 0; iteration < 40; iteration++) {
      const before = file(next, iteration % 2 === 0)
      const after = edit(next, before)
      await Bun.write(path.join(dir.path, "before.txt"), before)
      await Bun.write(path.join(dir.path, "after.txt"), after)
      const git = Bun.spawnSync(["git", "diff", "--no-index", "--numstat", "--", "before.txt", "after.txt"], {
        cwd: dir.path,
      })
      // Identical files print nothing. git splits lines on \n only, as the differ does.
      const [added, removed] = git.stdout.toString().split("\t")
      const result = run(before, after)
      expect([result.additions, result.deletions]).toEqual(before === after ? [0, 0] : [Number(added), Number(removed)])
    }
  })

  test("a large file with two distant edits is found quickly and the patch applies", () => {
    const base = Array.from({ length: 50_000 }, (_, index) => `line ${index}\n`)
    const edited = base.slice()
    edited[25_000] = "CHANGED\n"
    edited.splice(40_000, 0, "INSERTED\n")
    const result = run(base.join(""), edited.join(""), { oldName: "big.txt", newName: "big.txt" })

    // Too large for one exact pass, so it is anchored on unique lines and says so.
    expect(result.approximate).toBe(true)
    expect([result.additions, result.deletions]).toEqual([2, 1])
    expect(applyPatch(base.join(""), result.patch!)).toBe(edited.join(""))
  })

  test("a region with nothing to anchor on is a valid replacement and still applies", () => {
    const before = Array.from({ length: 30_000 }, (_, index) => `old ${index}\n`).join("")
    const after = Array.from({ length: 30_000 }, (_, index) => `new ${index}\n`).join("")
    const result = run(`head\n${before}tail\n`, `head\n${after}tail\n`, { oldName: "r", newName: "r" })

    expect(result.approximate).toBe(true)
    expect([result.additions, result.deletions]).toEqual([30_000, 30_000])
    expect(applyPatch(`head\n${before}tail\n`, result.patch!)).toBe(`head\n${after}tail\n`)
  })

  test("reports binary input without a patch, as git does", () => {
    const result = JSON.parse(diffText(new Uint8Array([1, 0, 2]), encoder.encode("text\n"), "{}")) as Result
    expect([result.binary, result.additions, result.deletions, result.patch]).toEqual([true, 0, 0, undefined])
  })
})
