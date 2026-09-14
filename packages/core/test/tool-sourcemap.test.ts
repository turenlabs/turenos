import fs from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SourcemapRuntime } from "@turenlabs/core/tool/sourcemap-runtime"
import { SourcemapTools } from "@turenlabs/core/tool/sourcemap-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

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
const it = testEffect(Layer.empty)

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        SourcemapRuntime.node,
        SourcemapTools.node,
      ]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    ),
  )

describe("SourcemapRuntime and SourcemapTools", () => {
  it.live("inspects, looks up, extracts, and flattens a real sourcemap through a fresh worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const source = "console.log('hello')\n"
          const map = {
            version: 3,
            file: "app.min.js",
            sources: ["app.js"],
            sourcesContent: [source],
            names: ["console"],
            mappings: "AAAA",
          }
          yield* Effect.promise(() => Bun.write(`${tmp.path}/app.map`, JSON.stringify(map)))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/junk.map`, "this is not a sourcemap"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of [
            "sourcemap_inspect",
            "sourcemap_lookup",
            "sourcemap_reverse_lookup",
            "sourcemap_source",
            "sourcemap_flatten",
          ])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_sourcemap_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })
          const artifact = (value: unknown) =>
            typeof value === "string" ? / to (\S+) \(sha256/.exec(value)?.[1] : undefined

          const inspected = yield* call("call-sourcemap-inspect", "sourcemap_inspect", { path: "app.map" })
          expect(inspected.type).toBe("text")
          if (inspected.type !== "text") return
          expect(inspected.value).toContain('"kind": "regular"')
          expect(inspected.value).toContain('"version": 3')
          expect(inspected.value).toContain("app.js")

          const lookedUp = yield* call("call-sourcemap-lookup", "sourcemap_lookup", {
            path: "app.map",
            line: 0,
            column: 0,
          })
          expect(lookedUp.type).toBe("text")
          if (lookedUp.type !== "text") return
          expect(lookedUp.value).toContain('"found": true')
          expect(lookedUp.value).toContain("app.js")

          const reversed = yield* call("call-sourcemap-reverse", "sourcemap_reverse_lookup", {
            path: "app.map",
            source: "app.js",
            line: 0,
          })
          expect(reversed.type).toBe("text")
          if (reversed.type !== "text") return
          expect(reversed.value).toContain('"positions"')
          expect(reversed.value).toContain('"match_count"')

          const extracted = yield* call("call-sourcemap-source", "sourcemap_source", { path: "app.map", index: 0 })
          expect(extracted.type).toBe("text")
          if (extracted.type !== "text") return
          const sourcePath = artifact(extracted.value)
          expect(sourcePath).toBeTruthy()
          expect(yield* Effect.promise(() => fs.readFile(sourcePath!, "utf8"))).toBe(source)

          const flattened = yield* call("call-sourcemap-flatten", "sourcemap_flatten", { path: "app.map" })
          expect(flattened.type).toBe("text")
          if (flattened.type !== "text") return
          const flattenedPath = artifact(flattened.value)
          expect(flattenedPath).toBeTruthy()
          const flat = JSON.parse(yield* Effect.promise(() => fs.readFile(flattenedPath!, "utf8"))) as {
            version?: number
            sources?: string[]
          }
          expect(flat.version).toBe(3)
          expect(flat.sources).toContain("app.js")

          const failed = yield* call("call-sourcemap-inspect-junk", "sourcemap_inspect", { path: "junk.map" })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
