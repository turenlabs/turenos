import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { retainedLegacyStoreFiles } from "./store-cleanup"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("legacy store retention", () => {
  test("startup inventory retains empty, old, and excess draft and workspace import sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-store-retention-"))
    roots.push(root)
    const old = new Date("2025-01-01T00:00:00.000Z")
    const names = [
      "forge.draft.empty.dat",
      "forge.draft.old.dat",
      ...Array.from({ length: 102 }, (_, index) => `forge.draft.${index}.dat`),
      "forge.workspace.empty.dat",
      "forge.global.dat",
    ]
    await Promise.all(
      names.map(async (name) => {
        await writeFile(join(root, name), name.includes("empty") ? "{}" : '{"state":"retained"}')
        await utimes(join(root, name), old, old)
      }),
    )

    expect(await retainedLegacyStoreFiles(root)).toEqual([...names].sort())
    expect((await readdir(root)).sort()).toEqual([...names].sort())
  })
})
