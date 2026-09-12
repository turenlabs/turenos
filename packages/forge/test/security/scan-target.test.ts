import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Scanner } from "@/security/util/scanner"
import { ToolError, type IntegrationContext } from "@/security/types"
import { tmpdir } from "../fixture/fixture"

function ctx(workspace: string): IntegrationContext {
  return { workspace, cacheDir: path.join(workspace, ".cache"), secrets: {} }
}

async function rejectsToolError(fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    if (error instanceof ToolError) expect(error.message).toMatch(match)
    return
  }
  throw new Error("expected ToolError")
}

test("resolves the workspace root for omitted, empty, and blank paths", async () => {
  await using tmp = await tmpdir()
  for (const raw of [undefined, "", "   ", "."]) {
    const target = await Scanner.resolveScanTarget(raw, ctx(tmp.path))
    expect(target.abs).toBe(tmp.path)
    expect(target.rel).toBe(".")
    expect(target.isDirectory).toBe(true)
  }
})

test("resolves nested relative paths and reports directory-ness", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "sub", "dir"), { recursive: true })
      await Bun.write(path.join(dir, "sub", "file.txt"), "x")
    },
  })
  const dir = await Scanner.resolveScanTarget(path.join("sub", "dir"), ctx(tmp.path))
  expect(dir.abs).toBe(path.join(tmp.path, "sub", "dir"))
  expect(dir.rel).toBe(path.join("sub", "dir"))
  expect(dir.isDirectory).toBe(true)

  const file = await Scanner.resolveScanTarget(path.join("sub", "file.txt"), ctx(tmp.path))
  expect(file.isDirectory).toBe(false)
})

test("accepts an absolute path inside the workspace", async () => {
  await using tmp = await tmpdir({ init: (dir) => fs.mkdir(path.join(dir, "in")) })
  const target = await Scanner.resolveScanTarget(path.join(tmp.path, "in"), ctx(tmp.path))
  expect(target.abs).toBe(path.join(tmp.path, "in"))
})

test("rejects escapes above the workspace", async () => {
  await using tmp = await tmpdir({ init: (dir) => fs.mkdir(path.join(dir, "sub")) })
  for (const raw of ["..", "../outside", path.join("sub", "..", "..", "outside"), path.join(tmp.path, "..")]) {
    await rejectsToolError(() => Scanner.resolveScanTarget(raw, ctx(tmp.path)), /inside the workspace/)
  }
})

test("rejects absolute paths outside the workspace, including same-prefix siblings", async () => {
  await using tmp = await tmpdir()
  const sibling = `${tmp.path}-evil`
  await fs.mkdir(sibling)
  try {
    await rejectsToolError(() => Scanner.resolveScanTarget(sibling, ctx(tmp.path)), /inside the workspace/)
    await rejectsToolError(() => Scanner.resolveScanTarget(path.parse(tmp.path).root, ctx(tmp.path)), /inside the workspace/)
  } finally {
    await fs.rm(sibling, { recursive: true, force: true })
  }
})

test("accepts a workspace entry whose name begins with dots", async () => {
  await using tmp = await tmpdir({ init: (dir) => fs.mkdir(path.join(dir, "..x")) })
  const target = await Scanner.resolveScanTarget("..x", ctx(tmp.path))
  expect(target.abs).toBe(path.join(tmp.path, "..x"))
})

test("rejects non-string input and missing targets", async () => {
  await using tmp = await tmpdir()
  for (const raw of [null, 42, {}, []]) {
    await rejectsToolError(() => Scanner.resolveScanTarget(raw, ctx(tmp.path)), /must be a string/)
  }
  await rejectsToolError(() => Scanner.resolveScanTarget("nope", ctx(tmp.path)), /does not exist/)
})
