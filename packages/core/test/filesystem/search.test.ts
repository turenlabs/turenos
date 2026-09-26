import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { FSUtil } from "@turenlabs/core/fs-util"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FileSystemSearch } from "@turenlabs/core/filesystem/search"
import { Location } from "@turenlabs/core/location"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
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
