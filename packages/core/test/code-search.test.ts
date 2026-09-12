import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Watcher } from "@turenlabs/core/filesystem/watcher"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { CodeSearch } from "@turenlabs/core/search"
import { SessionV2 } from "@turenlabs/core/session"
import { CodeSearchTool } from "@turenlabs/core/tool/code-search"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Event } from "@turenlabs/schema/event"
import { Potion, type PotionLoadOptions, type PotionRuntime } from "@turenlabs/plugin/potion"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_code_search_test")

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const activation = { enabled: true }
let listener: EventV2.Subscriber | undefined

const extensions = Layer.mock(ExtensionRuntime.Service, {
  enabled: () => Effect.succeed(activation.enabled),
})

const events = Layer.mock(EventV2.Service, {
  listen: (sub: EventV2.Subscriber) => Effect.sync(() => (listener = sub)).pipe(Effect.as(Effect.void)),
})

// the default test loader simulates an offline machine: potion never loads and
// search must still work; the thesaurus test installs a controlled runtime
const offline = (_options: PotionLoadOptions) => Promise.reject(new Error("offline"))

const runtime = (pair: readonly string[]): PotionRuntime => ({
  profile: { model: Potion.model, revision: Potion.revision, dimension: 2, dimensions: 2, maxTokens: 512 },
  embed: (texts) => texts.map((text) => new Float32Array(pair.includes(text) ? [1, 0] : [0, 1])),
  close: () => undefined,
})

const withSearch = <A, E, R>(
  directory: string,
  load: (options: PotionLoadOptions) => Promise<PotionRuntime>,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          Location.node,
          FSUtil.node,
          Ripgrep.node,
          CodeSearch.node,
          CodeSearchTool.node,
        ]),
        [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          [EventV2.node, events],
          [ExtensionRuntime.node, extensions],
          [CodeSearch.node, CodeSearch.nodeWith(load)],
        ],
      ),
    ),
  )

let callN = 0
const call = (input: typeof CodeSearchTool.Input.Type) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-code-search-${++callN}`, name: "code_search", input },
})

const search = (registry: ToolRegistry.Interface, input: typeof CodeSearchTool.Input.Type) =>
  Effect.map(
    settleTool(registry, call(input)),
    (settled) => settled.output?.structured as typeof CodeSearchTool.Output.Encoded,
  )

const seed = async (dir: string) => {
  const write = (rel: string, content: string) =>
    fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true }).then(() => fs.writeFile(path.join(dir, rel), content))

  await write(
    "src/core/coordinator.ts",
    `export class SessionRunCoordinator {
  join() { return true }
  resume() { return false }
}
export function promote() { return "ok" }
`,
  )
  await write(
    "src/app/main.ts",
    `import { SessionRunCoordinator } from "../core/coordinator"
export function boot() {
  const coordinator = new SessionRunCoordinator()
  coordinator.join()
}
`,
  )
  await write(
    "src/packers.rs",
    `fn detect_packer(input: &[u8]) -> bool {
    input.len() > 64
}
struct PackerRule { marker: u8 }
`,
  )
  // "checksum" must land in at least three chunks to enter the thesaurus vocab,
  // and the corpus must be large enough that it stays under the df ceiling
  const hashLines = [
    `export function sha256(data: string) { return data.length }`,
    `export function checksumMatch(a: string, b: string) { return a === b }`,
  ]
  for (let i = 0; i < 330; i++) {
    hashLines.push(i % 97 === 0 ? `// checksum digest sha256 integrity guard ${i}` : `const pad${i} = ${i}`)
  }
  await write("src/util/hash.ts", hashLines.join("\n"))
  await write("docs/guide.md", "Generate a session title from the first user message by summarizing the request.\n")
  // padding so the corpus is large enough for vocabulary statistics
  for (let i = 0; i < 20; i++) {
    const lines = [`export const value${i} = ${i}`]
    for (let j = 0; j < 110; j++) lines.push(`export function compute${i}x${j}(x: number) { return x + ${j} }`)
    await write(`src/pad/f${i}.ts`, lines.join("\n"))
  }
}

const updated = (dir: string, file: string): EventV2.Payload => ({
  id: Schema.decodeUnknownSync(Event.ID)("evt_test"),
  type: Watcher.Event.Updated.type,
  data: { file: AbsolutePath.make(path.join(dir, file)), event: "change" },
  location: { directory: AbsolutePath.make(dir) },
})

const it = testEffect(Layer.empty)

describe("code_search", () => {
  it.live("ranks the defining file first for an identifier query", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            const hits = yield* search(registry, { queries: ["SessionRunCoordinator joins session resumes"] })
            expect(hits[0]?.path).toBe("src/core/coordinator.ts")
            expect(hits[0]?.line).toBeGreaterThan(0)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("finds declarations in languages without a yolk parser", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            const hits = yield* search(registry, { queries: ["packer detection marker rules"] })
            expect(hits.slice(0, 3).some((hit) => hit.path === "src/packers.rs")).toBe(true)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("still retrieves when the yolk extension is disabled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            activation.enabled = false
            try {
              yield* Effect.promise(() => seed(tmp.path))
              const hits = yield* search(registry, { queries: ["SessionRunCoordinator"] })
              expect(hits[0]?.path).toBe("src/core/coordinator.ts")
            } finally {
              activation.enabled = true
            }
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("merges independent query variants by best score", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            const hits = yield* search(registry, { queries: ["qwxy nonexistent zzz", "SessionRunCoordinator"] })
            expect(hits.some((hit) => hit.path === "src/core/coordinator.ts")).toBe(true)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("scopes results to a subdirectory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            const hits = yield* search(registry, { queries: ["session title generation"], path: RelativePath.make("docs") })
            expect(hits.length).toBeGreaterThan(0)
            expect(hits.every((hit) => hit.path.startsWith("docs/"))).toBe(true)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("bounds the result count", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            const hits = yield* search(registry, { queries: ["export function"], limit: 2 })
            expect(hits.length).toBeLessThanOrEqual(2)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("bridges vocabulary through the corpus thesaurus", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(
          tmp.path,
          () => Promise.resolve(runtime(["verify", "checksum"])),
          (registry) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => seed(tmp.path))
              // "verify" appears nowhere in the corpus; the thesaurus must bridge
              // it to "checksum" which only lives in hash.ts
              const hits = yield* search(registry, { queries: ["verify"] })
              expect(hits[0]?.path).toBe("src/util/hash.ts")
            }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("routes caller intent through the call graph", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            const hits = yield* search(registry, { queries: ["callers of the join method"] })
            const main = hits.findIndex((hit) => hit.path === "src/app/main.ts")
            expect(main).toBeGreaterThanOrEqual(0)
            expect(main).toBeLessThanOrEqual(1)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reindexes a file after a watcher update", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withSearch(tmp.path, offline, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => seed(tmp.path))
            yield* search(registry, { queries: ["zebra locator"] })

            const file = path.join(tmp.path, "src/core/coordinator.ts")
            yield* Effect.promise(() =>
              fs.appendFile(file, "\nexport function zebraLocator() { return 1 }\n"),
            )
            yield* listener!(updated(tmp.path, "src/core/coordinator.ts"))

            const hits = yield* search(registry, { queries: ["zebra locator"] })
            expect(hits[0]?.path).toBe("src/core/coordinator.ts")
            expect(hits[0]?.name).toBe("zebraLocator")
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
