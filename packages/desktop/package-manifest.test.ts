import { expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

// electron-builder writes a stripped package.json (no scripts, plus desktopName)
// into the packaged app. Copying that back over the source silently breaks
// `bun dev`, `bun run build`, and `bun turbo typecheck` coverage for desktop.
test("package.json keeps its source scripts and no packaged-app metadata", async () => {
  const pkg = await Bun.file(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json")).json()
  expect(Object.keys(pkg.scripts ?? {})).toEqual(
    expect.arrayContaining(["typecheck", "dev", "build", "package", "test"]),
  )
  expect(pkg.desktopName).toBeUndefined()
})
