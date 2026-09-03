import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ForensicRuntime } from "@turenlabs/core/tool/forensic-runtime"
import { ForensicTools } from "@turenlabs/core/tool/forensic-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(AppNodeBuilder.build(ForensicRuntime.node))
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

describe("ForensicRuntime", () => {
  it.live("rebuilds a sorted timeline from bodyfile and artifact JSON", () =>
    Effect.gen(function* () {
      const runtime = yield* ForensicRuntime.Service
      const timeline = yield* runtime.analyze({
        target: "rebuild-timeline",
        bytes: new TextEncoder().encode("0|/tmp/a|1|r/rrwxrwxrwx|0|0|4|100|200|300|400\n"),
        options: {
          artifacts: JSON.stringify([{ kind: "prefetch", executable: "CMD.EXE", lastRunTimes: [500], runCount: 2 }]),
        },
      })
      expect(timeline).toMatchObject({ schemaVersion: 1 })
      const result = timeline.result as { count: number; events: ReadonlyArray<{ timestamp: number; source: string }> }
      expect(result.count).toBeGreaterThanOrEqual(5)
      expect(result.events.map((event) => event.timestamp)).toEqual(
        [...result.events.map((event) => event.timestamp)].sort((left, right) => left - right),
      )
      expect(result.events.some((event) => event.source === "prefetch")).toBe(true)
    }),
  )

  testEffect(Layer.empty).live("registers three forensic tools", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(`${tmp.path}/sample.body`, "0|/tmp/a|1|r/rrwxrwxrwx|0|0|4|100|200|300|400\n"),
          )
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([
            "rebuild_timeline",
            "wifi_offline",
            "windows_artifacts",
          ])
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_forensic_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-timeline",
              name: "rebuild_timeline",
              input: { path: "sample.body" },
            },
          })
          expect(result.type).toBe("text")
          if (result.type === "text") expect(result.value).toContain('"source": "bodyfile"')
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                ForensicRuntime.node,
                ForensicTools.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                ],
                [PermissionV2.node, permission],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
