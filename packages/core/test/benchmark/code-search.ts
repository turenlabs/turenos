import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { EventV2 } from "../../src/event"
import { ExtensionRuntime } from "../../src/extension"
import { AbsolutePath } from "../../src/schema"
import { CodeSearch } from "../../src/search"
import { Location } from "../../src/location"
import { Potion } from "@turenlabs/plugin/potion"
import { location } from "../fixture/location"

// Expected implementation files, not tests or references to the same feature.
const tuning = [
  ["code_search tool implementation", "packages/core/src/tool/code-search.ts"],
  ["code search indexing ranking", "packages/core/src/search/index.ts"],
  ["SessionRunCoordinator", "packages/core/src/session/run-coordinator.ts"],
  ["ripgrep file enumeration", "packages/core/src/ripgrep.ts"],
  ["filesystem watcher updates", "packages/core/src/filesystem/watcher.ts"],
  ["permission assert ask reply", "packages/core/src/permission.ts"],
  ["Potion embedding tokenizer", "packages/plugin/src/potion.ts"],
  ["tool registry registration", "packages/core/src/tool/registry.ts"],
  ["protected filesystem paths", "packages/core/src/filesystem/protected.ts"],
  ["secret vault credentials encryption", "packages/core/src/secret-vault.ts"],
  ["session history projection", "packages/core/src/session/history.ts"],
  ["shell command safety", "packages/core/src/shell-safety.ts"],
  ["release automation signing publish", "docs/release-automation.md"],
  ["parseGoUnit", "packages/core/src/yolk/indexer/index.ts"],
  ["HTTP API server routes", "packages/server/src/api.ts"],
] as const

const root = path.resolve(import.meta.dir, "../../../..")
const heldout = (await Bun.file(path.join(import.meta.dir, "code-search-queries.json")).json()) as {
  query: string
  targets: string[]
}[]
const cases = [
  ...tuning.map(([query, target]) => ({ query, targets: [target], suite: "tuning" })),
  ...heldout.map((item) => ({ ...item, suite: "heldout" })),
]
const revision = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length)
const experiment = process.argv.find((arg) => arg.startsWith("--experiment="))?.slice("--experiment=".length)
await using implementation = await (async () => {
  if (!revision && !experiment) return { search: CodeSearch, [Symbol.asyncDispose]: async () => undefined }
  const { spawnSync } = await import("node:child_process")
  const { mkdtemp, unlink, rmdir } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const committed = revision
    ? spawnSync("git", ["show", `${revision}:packages/core/src/search/index.ts`], {
        cwd: root,
        encoding: "utf8",
      })
    : undefined
  if (committed && committed.status !== 0) throw new Error(committed.stderr)
  const captured = Bun.file(path.join(import.meta.dir, "search-experiments/source.json"))
  const current = committed?.stdout ?? (await Bun.file(path.join(root, "packages/core/src/search/index.ts")).text())
  if (process.argv.includes("--snapshot")) await Bun.write(captured, JSON.stringify({ source: current }, null, 2))
  const source =
    experiment && (await captured.exists()) ? ((await captured.json()) as { source: string }).source : current
  const transformed = experiment
    ? await (async () => {
        if (!/^[a-z-]+$/.test(experiment)) throw new Error("Invalid experiment name")
        const { transform } = (await import(path.join(import.meta.dir, "search-experiments", `${experiment}.ts`))) as {
          transform: (source: string) => string
        }
        return transform(source)
      })()
    : source
  const directory = await mkdtemp(path.join(tmpdir(), "code-search-baseline-"))
  const file = path.join(directory, "index.ts")
  // Resolve the committed module's imports against this checkout's dependencies.
  await Bun.write(
    file,
    transformed.replace(
      /(from\s+")([^"]+)(")/g,
      (_, before: string, specifier: string, after: string) =>
        before +
        (specifier === "."
          ? file
          : /^(node|bun):/.test(specifier)
            ? specifier
            : Bun.resolveSync(specifier, path.join(root, "packages/core/src/search"))) +
        after,
    ),
  )
  {
    const { CodeSearch } = (await import(file)) as typeof import("../../src/search")
    return {
      search: CodeSearch,
      [Symbol.asyncDispose]: async () => {
        await unlink(file)
        await rmdir(directory)
      },
    }
  }
})()
// Refuse stale labels rather than silently counting missing files as misses.
for (const item of cases) {
  for (const file of item.targets) {
    if (!(await Bun.file(path.join(root, file)).exists())) throw new Error(`Missing benchmark target: ${file}`)
  }
}
const offline = process.argv.includes("--offline")
const times: number[] = []
const ranks: { query: string; suite: string; rank: number; first?: string }[] = []
const percentile = (values: number[], p: number) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1]!
const quality = (items: typeof ranks) => ({
  recall10: items.filter((r) => r.rank > 0).length / items.length,
  mrr10: items.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / items.length,
  top1: items.filter((r) => r.rank === 1).length,
})

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const search = yield* implementation.search.Service
      Bun.gc(true)
      const before = process.memoryUsage()
      const start = performance.now()
      yield* search.search({ queries: [cases[0]!.query], limit: 10 })
      const cold = performance.now() - start
      Bun.gc(true)
      const after = process.memoryUsage()
      for (let pass = 0; pass < 3; pass++) {
        for (const item of cases) {
          const start = performance.now()
          const hits = yield* search.search({ queries: [item.query], limit: 10 })
          times.push(performance.now() - start)
          if (pass === 0)
            ranks.push({
              query: item.query,
              suite: item.suite,
              rank: hits.findIndex((hit) => item.targets.includes(hit.path)) + 1,
              first: hits[0]?.path,
            })
        }
      }
      console.log(
        JSON.stringify(
          {
            mode: offline ? "offline" : "semantic",
            revision: revision ?? "worktree",
            experiment,
            cases: cases.length,
            ...quality(ranks),
            tuning: quality(ranks.filter((r) => r.suite === "tuning")),
            heldout: quality(ranks.filter((r) => r.suite === "heldout")),
            coldMs: cold,
            p50Ms: percentile(times, 0.5),
            p95Ms: percentile(times, 0.95),
            firstPassP50Ms: percentile(times.slice(0, cases.length), 0.5),
            firstPassP95Ms: percentile(times.slice(0, cases.length), 0.95),
            cachedP50Ms: percentile(times.slice(cases.length), 0.5),
            cachedP95Ms: percentile(times.slice(cases.length), 0.95),
            heapDeltaMiB: (after.heapUsed - before.heapUsed) / 1048576,
            rssDeltaMiB: (after.rss - before.rss) / 1048576,
            peakRssMiB: process.resourceUsage().maxRSS / 1024,
            ranks: process.argv.includes("--summary") ? undefined : ranks,
          },
          null,
          2,
        ),
      )
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(implementation.search.node, [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
          ],
          [EventV2.node, Layer.mock(EventV2.Service, { listen: () => Effect.succeed(Effect.void) })],
          [ExtensionRuntime.node, Layer.mock(ExtensionRuntime.Service, { enabled: () => Effect.succeed(true) })],
          [
            implementation.search.node,
            implementation.search.nodeWith(offline ? () => Promise.reject(new Error("offline")) : Potion.load),
          ],
        ]),
      ),
    ),
  ),
)
