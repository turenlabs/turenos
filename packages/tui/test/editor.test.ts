import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { composeInEditor, editorArgv } from "../src/editor"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

// A real subprocess, not a mock: it receives the draft path exactly as a real
// editor would, records what it was handed, and then acts out one case.
const script = `
import { readFileSync, statSync, writeFileSync } from "node:fs"
const file = process.argv[2]
writeFileSync(
  process.env.CAPTURE,
  JSON.stringify({
    file,
    mode: statSync(file).mode & 0o777,
    received: readFileSync(file, "utf8"),
    env: Object.keys(process.env),
  }),
)
if (process.env.MODE === "write") writeFileSync(file, process.env.TEXT)
if (process.env.MODE === "fail") process.exit(3)
`

function editor(mode: "write" | "fail" | "noop", text = "") {
  const directory = mkdtempSync(join(tmpdir(), "turen-tui-test-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "fake-editor.ts")
  writeFileSync(path, script)
  const capture = join(directory, "capture.json")
  return {
    env: {
      EDITOR: `"${process.execPath}" "${path}"`,
      CAPTURE: capture,
      MODE: mode,
      TEXT: text,
    } as NodeJS.ProcessEnv,
    handed: () =>
      JSON.parse(readFileSync(capture, "utf8")) as { file: string; mode: number; received: string; env: string[] },
  }
}

test("the editor command comes from VISUAL, then EDITOR, and splits quoted arguments", () => {
  expect(editorArgv({})).toBeUndefined()
  expect(editorArgv({ EDITOR: "   " })).toBeUndefined()
  expect(editorArgv({ EDITOR: "vim" })).toEqual(["vim"])
  expect(editorArgv({ EDITOR: "vim", VISUAL: "code --wait" })).toEqual(["code", "--wait"])
  // A GUI editor path can contain spaces; quoting applies to whole arguments.
  expect(editorArgv({ VISUAL: `"/opt/My Editor/bin/ed" --wait` })).toEqual(["/opt/My Editor/bin/ed", "--wait"])
  expect(editorArgv({ VISUAL: "  subl   -w  " })).toEqual(["subl", "-w"])
})

test("the draft round-trips through a private file that is removed afterwards", async () => {
  const fake = editor("write", "Edited in the editor.\n")
  expect(await composeInEditor("Original draft", fake.env)).toBe("Edited in the editor.")
  const handed = fake.handed()
  expect(handed.received).toBe("Original draft")
  // The draft is operator text: private to this user while it exists, gone after.
  expect(handed.mode).toBe(0o600)
  expect(handed.file).toEndWith(".md")
  expect(existsSync(handed.file)).toBe(false)
  expect(existsSync(dirname(handed.file))).toBe(false)
})

test("a refused or failed edit keeps the draft and still removes the file", async () => {
  const failed = editor("fail")
  await expect(composeInEditor("Original draft", failed.env)).rejects.toThrow("exited with status 3")
  expect(existsSync(dirname(failed.handed().file))).toBe(false)

  // Opening and quitting without saving returns the draft unchanged.
  const untouched = editor("noop")
  expect(await composeInEditor("Original draft", untouched.env)).toBe("Original draft")

  const missing = { EDITOR: "/nonexistent/editor-binary" }
  await expect(composeInEditor("Original draft", missing)).rejects.toThrow("Cannot start")
  await expect(composeInEditor("Original draft", {})).rejects.toThrow("Set $EDITOR")
})

test("editor content is bounded and sanitized without losing real formatting", async () => {
  const oversized = editor("write", "x".repeat(32001))
  await expect(composeInEditor("", oversized.env)).rejects.toThrow("below 32,000 characters")
  expect(existsSync(dirname(oversized.handed().file))).toBe(false)

  const controls = editor("write", "line one\n\ttabbed\u0007\u001b[31m\n\n\n")
  const composed = await composeInEditor("", controls.env)
  // Newlines and tabs are draft formatting; terminal controls are not.
  expect(composed).toBe("line one\n\ttabbed[31m")
  expect(composed).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
})

test("the editor never sees the server password or the vault key", async () => {
  const fake = editor("noop")
  await composeInEditor("draft", {
    ...fake.env,
    FORGE_SERVER_PASSWORD: "secret",
    FORGE_SECRET_VAULT_KEY: "key",
    FORGE_SECRET_VAULT_KEY_ID: "id",
  })
  const seen = fake.handed().env
  expect(seen).toContain("CAPTURE")
  for (const name of ["FORGE_SERVER_PASSWORD", "FORGE_SECRET_VAULT_KEY", "FORGE_SECRET_VAULT_KEY_ID"])
    expect(seen).not.toContain(name)
})
