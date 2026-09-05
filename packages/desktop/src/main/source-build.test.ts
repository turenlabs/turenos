import { describe, expect, test } from "bun:test"
import path from "node:path"

describe("Desktop source build", () => {
  test("ships every Forge build script referenced by Desktop", async () => {
    const forge = path.resolve(import.meta.dirname, "../../../forge")
    expect(await Bun.file(path.join(forge, "script/build.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(forge, "script/build-node.ts")).exists()).toBe(true)
  })
})
