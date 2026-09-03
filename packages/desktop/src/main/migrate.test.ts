import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTauriLegacyStores } from "./migrate"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Tauri legacy Storage input", () => {
  test("merges the retained source without staging into or mutating electron-store", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-tauri-import-"))
    roots.push(root)
    const source = '{"defaultServerUrl":"http://tauri","pinchZoomEnabled":true}'
    await writeFile(join(root, "forge.settings.dat"), source)
    const electron = { store: { defaultServerUrl: "http://electron" } }

    const merged = readTauriLegacyStores(root).merge("forge.settings", electron)

    expect(merged.store).toEqual({ defaultServerUrl: "http://electron", pinchZoomEnabled: true })
    expect(electron.store).toEqual({ defaultServerUrl: "http://electron" })
    expect(await readFile(join(root, "forge.settings.dat"), "utf8")).toBe(source)
  })

  test("surfaces an unreadable source so no downstream import can record a false receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-tauri-import-"))
    roots.push(root)
    await writeFile(join(root, "forge.settings.dat"), "not-json")

    expect(() => readTauriLegacyStores(root).merge("forge.settings", { store: {} })).toThrow()
  })
})
