import { describe, expect, test } from "bun:test"
import { access } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { layer } from "../src/database/sqlite.node"
import { tmpdir } from "./fixture/tmpdir"

describe("node:sqlite adapter", () => {
  test("does not create a missing database when create is false", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "missing.db")
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer({ filename, create: false }))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      await access(filename).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })
})
