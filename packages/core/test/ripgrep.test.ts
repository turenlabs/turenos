import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { RelativePath } from "@turenlabs/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep", () => {
  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("counts lines for the exact files it is given", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "three.ts"), "a\nb\nc\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "partial.ts"), "no trailing newline"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "empty.ts"), ""))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "missing:colon.ts"), "x\ny\n"))

          const counts = yield* (yield* Ripgrep.Service).lines({
            cwd: tmp.path,
            files: ["src/three.ts", "partial.ts", "empty.ts", "missing:colon.ts", "absent.ts"],
          })
          expect(counts.get("src/three.ts")).toBe(3)
          // A file without a trailing newline still ends in one line.
          expect(counts.get("partial.ts")).toBe(1)
          expect(counts.get("empty.ts")).toBe(0)
          // The count is separated by the last colon, so a colon in the path survives.
          expect(counts.get("missing:colon.ts")).toBe(2)
          expect(counts.has("absent.ts")).toBe(false)

          expect((yield* (yield* Ripgrep.Service).lines({ cwd: tmp.path, files: [] })).size).toBe(0)

          // More paths than one command line can carry: every file still gets a count.
          const many = yield* Effect.forEach(
            Array.from({ length: 400 }, (_, index) => `${"nested-directory-".repeat(8)}${index}.ts`),
            (name) => Effect.promise(() => fs.writeFile(path.join(tmp.path, name), "x\n")).pipe(Effect.as(name)),
            { concurrency: 16 },
          )
          const batched = yield* (yield* Ripgrep.Service).lines({ cwd: tmp.path, files: many })
          expect(batched.size).toBe(many.length)
          expect([...new Set(batched.values())]).toEqual([1])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".forge")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".forge", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".forge/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".forge/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
