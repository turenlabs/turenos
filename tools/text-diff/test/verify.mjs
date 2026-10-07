import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_text_diff_wasm.js")).href)
await api.default({
  module_or_path: await readFile(path.join(directory, "turen_text_diff_wasm_bg.wasm")),
})

const enc = new TextEncoder()
const diff = (before, after, options = {}) =>
  JSON.parse(api.diff_text(enc.encode(before), enc.encode(after), JSON.stringify(options)))
const same = { oldName: "a.txt", newName: "a.txt" }
const head = "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n"

// Exact bytes jsdiff 8.0.4's createTwoFilesPatch printed for these inputs.
{
  const result = diff("one\ntwo\nthree\n", "one\nTWO\nthree\n", same)
  assert.equal(result.patch, `${head}@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`)
  assert.deepEqual([result.additions, result.deletions, result.binary], [1, 1, false])
  assert.equal(result.schema_version, 1)
}
{
  assert.equal(
    diff("a\nb", "a\nb\n", same).patch,
    `${head}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n`,
  )
  assert.equal(diff("", "x\ny\n", same).patch, `${head}@@ -0,0 +1,2 @@\n+x\n+y\n`)
  assert.equal(diff("x\ny\n", "", same).patch, `${head}@@ -1,2 +0,0 @@\n-x\n-y\n`)
  assert.equal(
    diff("1\n2\n3\n", "1\n2\nNEW\n3\n", { ...same, context: 0 }).patch,
    `${head}@@ -2,0 +3,1 @@\n+NEW\n`,
  )
}
// Different names drop the Index line; CRLF bytes survive.
{
  assert.equal(
    diff("a\r\n", "b\r\n", { oldName: "old.txt", newName: "new.txt" }).patch,
    "===================================================================\n--- old.txt\n+++ new.txt\n@@ -1,1 +1,1 @@\n-a\r\n+b\r\n",
  )
}
// Counts only, binary, and lossy input.
{
  const counts = diff("a\n", "b\nc\n", { patch: false })
  assert.equal(counts.patch, undefined)
  assert.deepEqual([counts.additions, counts.deletions], [2, 1])
  const binary = JSON.parse(api.diff_text(new Uint8Array([0, 1, 2]), enc.encode("text\n"), ""))
  assert.deepEqual([binary.binary, binary.additions, binary.deletions, binary.patch], [true, 0, 0, undefined])
  const lossy = JSON.parse(api.diff_text(new Uint8Array([97, 0xff, 10]), enc.encode("a\n"), ""))
  assert.equal(lossy.lossy, true)
}
// Bad requests are JSON errors, never throws.
{
  assert.equal(diff("a", "b", { nope: 1 }).error, "options_invalid")
  assert.equal(JSON.parse(api.diff_text(enc.encode("a"), enc.encode("b"), "{")).error, "options_invalid")
  assert.equal(JSON.parse(api.diff_text(enc.encode("a"), enc.encode("b"), " ".repeat(5000))).error, "options_too_large")
  assert.equal(
    JSON.parse(api.diff_text(new Uint8Array(32 * 1024 * 1024 + 1).fill(97), new Uint8Array(0), "")).error,
    "input_too_large",
  )
}
// Bounded work: a large fully-different pair finishes, is flagged approximate, and still counts exactly.
{
  const lines = (prefix) => Array.from({ length: 60_000 }, (_, index) => `${prefix} ${index}\n`).join("")
  const started = performance.now()
  const result = diff(lines("old"), lines("new"), { patch: false })
  assert.equal(result.approximate, true)
  assert.deepEqual([result.additions, result.deletions], [60_000, 60_000])
  assert.ok(performance.now() - started < 5_000, "bounded diff must not take seconds")
}
// A large similar file is quick and finds the real edits, the case that matters in practice. It is too big for
// one exact pass, so it is anchored on unique lines and reported approximate.
{
  const base = Array.from({ length: 50_000 }, (_, index) => `line ${index}\n`)
  const edited = base.slice()
  edited[25_000] = "CHANGED\n"
  edited.splice(40_000, 0, "INSERTED\n")
  const started = performance.now()
  const result = diff(base.join(""), edited.join(""), same)
  assert.equal(result.approximate, true)
  assert.deepEqual([result.additions, result.deletions], [2, 1])
  assert.equal(result.patch.split("\n").filter((line) => line.startsWith("@@ ")).length, 2)
  assert.ok(performance.now() - started < 2_000)
}
// A file within the work budget is exact.
{
  const base = Array.from({ length: 10_000 }, (_, index) => `line ${index}\n`)
  const edited = base.slice()
  edited[100] = "CHANGED\n"
  edited.splice(9_000, 1)
  const result = diff(base.join(""), edited.join(""), { patch: false })
  assert.equal(result.approximate, false)
  assert.deepEqual([result.additions, result.deletions], [1, 2])
}
console.log("text-diff wasm verified")
