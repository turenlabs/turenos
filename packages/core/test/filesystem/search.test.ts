import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { FSUtil } from "@turenlabs/core/fs-util"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FileSystemSearch } from "@turenlabs/core/filesystem/search"
import { Location } from "@turenlabs/core/location"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { Fff } from "#fff"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

test("indexes each parent directory once for search", async () => {
  const tmp = await tmpdir()
  try {
    await fs.mkdir(path.join(tmp.path, "nested", "deep"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "nested", "deep", "match.txt"), "needle\n")

    const runtime = AppNodeBuilder.build(
      LayerNode.make({
        service: FileSystemSearch.Service,
        layer: FileSystemSearch.ripgrepLayer,
        deps: [FSUtil.node, Location.node, Ripgrep.node],
      }),
      [
        [
          Location.node,
          Layer.succeed(
            Location.Service,
            Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
          ),
        ],
      ],
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        for (let attempt = 0; attempt < 100; attempt++) {
          const found = yield* search.find({ query: "deep", type: "directory", limit: 10 })
          if (found.some((entry) => entry.path === RelativePath.make(path.join("nested", "deep") + path.sep))) {
            return found
          }
          yield* Effect.sleep("10 millis")
        }
        return []
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )

    expect(result.map((entry) => entry.path)).toContain(RelativePath.make(path.join("nested", "deep") + path.sep))
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
})

// The finder is built on the first search, and fff returns nothing until its scan finishes. An
// empty first grep would tell an agent the code has no matches.
test.skipIf(!Fff.available())("answers the first fff search after its scan", async () => {
  const tmp = await tmpdir()
  try {
    await fs.mkdir(path.join(tmp.path, "src"))
    await fs.writeFile(path.join(tmp.path, "src", "match.ts"), "needle\n")

    const runtime = AppNodeBuilder.build(
      LayerNode.make({
        service: FileSystemSearch.Service,
        layer: FileSystemSearch.fffLayer,
        deps: [FSUtil.node, Location.node, Ripgrep.node],
      }),
      [
        [
          Location.node,
          Layer.succeed(
            Location.Service,
            Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
          ),
        ],
      ],
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        const grep = yield* search.grep({ pattern: "needle", limit: 10 })
        const found = yield* search.find({ query: "match", type: "file", limit: 10 })
        return { grep: grep.map((match) => match.entry.path), found: found.map((entry) => entry.path) }
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )

    expect(result.grep).toEqual([RelativePath.make("src/match.ts")])
    expect(result.found).toContain(RelativePath.make("src/match.ts"))
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
})

// Stopping a turn interrupts the search that is building the finder. The build has to outlive that
// search: `Effect.cached` otherwise keeps the interruption as the answer to every later search.
test.skipIf(!Fff.available())("answers a later search after the first was interrupted while building", async () => {
  const tmp = await tmpdir()
  try {
    await fs.mkdir(path.join(tmp.path, "src"))
    await fs.writeFile(path.join(tmp.path, "src", "match.ts"), "needle\n")

    const runtime = AppNodeBuilder.build(
      LayerNode.make({
        service: FileSystemSearch.Service,
        layer: FileSystemSearch.fffLayer,
        deps: [FSUtil.node, Location.node, Ripgrep.node],
      }),
      [
        [
          Location.node,
          Layer.succeed(
            Location.Service,
            Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
          ),
        ],
      ],
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        // Runs until the build suspends on the scan, then the turn is stopped.
        const first = yield* search
          .grep({ pattern: "needle", limit: 10 })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(first)
        const grep = yield* search.grep({ pattern: "needle", limit: 10 })
        return grep.map((match) => match.entry.path)
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )

    expect(result).toEqual([RelativePath.make("src/match.ts")])
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
})

// Without fff both selections resolve to ripgrep, so the test could not tell them apart.
test.skipIf(!Fff.available())("uses ripgrep instead of fff when the file watcher is disabled", async () => {
  const tmp = await tmpdir()
  try {
    await fs.writeFile(path.join(tmp.path, "early.ts"), "needle\n")

    const runtime = AppNodeBuilder.build(
      LayerNode.make({
        service: FileSystemSearch.Service,
        layer: FileSystemSearch.locationLayer,
        deps: [FSUtil.node, Location.node, Ripgrep.node],
      }),
      [
        [
          Location.node,
          Layer.succeed(
            Location.Service,
            Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
          ),
        ],
      ],
    ).pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" })),
      ),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        // The initial ripgrep scan runs in a forked fiber, so wait for it before adding the late file.
        for (let attempt = 0; attempt < 100; attempt++) {
          const early = yield* search.find({ query: "early", type: "file", limit: 10 })
          if (early.length > 0) break
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "late.ts"), "needle\n"))
        // ripgrep runs live per call, so glob sees the new file.
        const globbed = yield* search.glob({ pattern: "*.ts", limit: 10 })
        // The ripgrep find index is a one-shot snapshot. fff would have picked the file up through its watcher.
        yield* Effect.sleep("1500 millis")
        const found = yield* search.find({ query: "late", type: "file", limit: 10 })
        return { globbed: globbed.map((entry) => entry.path).sort(), found: found.map((entry) => entry.path) }
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )

    expect(result.globbed).toEqual([RelativePath.make("early.ts"), RelativePath.make("late.ts")])
    expect(result.found).not.toContain(RelativePath.make("late.ts"))
  } finally {
    await tmp[Symbol.asyncDispose]()
  }
})
