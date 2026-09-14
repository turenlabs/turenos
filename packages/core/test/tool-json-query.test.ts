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
import { JsonQueryRuntime } from "@turenlabs/core/tool/json-query-runtime"
import { JsonQueryTools } from "@turenlabs/core/tool/json-query-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
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
        JsonQueryRuntime.node,
        JsonQueryTools.node,
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

describe("JsonQueryRuntime and JsonQueryTools", () => {
  it.live("queries, validates, summarizes, and enumerates JSON through a fresh json-query worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(`${tmp.path}/doc.json`, JSON.stringify({ a: [1, 2, 3], b: { c: "x" }, name: "doc" })),
          )
          yield* Effect.promise(() => Bun.write(`${tmp.path}/bad.json`, "{ not json ]"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["json_query", "json_validate", "json_stats", "json_paths"]) expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_json_query_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const queried = yield* call("call-json-query", "json_query", {
            path: "doc.json",
            filter: ".a | length",
          })
          expect(queried.type).toBe("text")
          if (queried.type !== "text") return
          expect(queried.value).toContain('"schema_version"')
          const queryReport = JSON.parse(String(queried.value)) as { results?: unknown[] }
          expect(queryReport.results).toEqual([3])

          const validated = yield* call("call-json-validate", "json_validate", { path: "doc.json" })
          expect(validated.type).toBe("text")
          if (validated.type !== "text") return
          expect(validated.value).toContain('"valid": true')
          expect(validated.value).toContain('"stats"')

          const stats = yield* call("call-json-stats", "json_stats", { path: "doc.json" })
          expect(stats.type).toBe("text")
          if (stats.type !== "text") return
          expect(stats.value).toContain('"type": "object"')
          expect(stats.value).toContain('"keys"')

          const paths = yield* call("call-json-paths", "json_paths", { path: "doc.json" })
          expect(paths.type).toBe("text")
          if (paths.type !== "text") return
          expect(paths.value).toContain('"paths"')
          expect(paths.value).toContain(".a[0]")

          const invalid = yield* call("call-json-validate-bad", "json_validate", { path: "bad.json" })
          expect(invalid.type).toBe("text")
          if (invalid.type !== "text") return
          expect(invalid.value).toContain('"valid": false')

          const failed = yield* call("call-json-stats-bad", "json_stats", { path: "bad.json" })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
