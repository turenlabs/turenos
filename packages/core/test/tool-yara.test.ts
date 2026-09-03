import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { YaraTool } from "@turenlabs/core/tool/yara"
import { YaraRuntime } from "@turenlabs/core/tool/yara-runtime"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
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

describe("YaraTool", () => {
  it.live("scans binary bytes with bounded YARA-X matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/sample.bin`, "abc abc"))
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["yara_scan"])
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_yara_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-yara",
              name: "yara_scan",
              input: {
                path: "sample.bin",
                maxMatchesPerPattern: 1,
                rules: `
                  rule marker : test {
                    meta:
                      owner = "turen"
                    strings:
                      $a = "abc"
                    condition:
                      $a
                  }
                `,
              },
            },
          })
          expect(result.type).toBe("text")
          if (result.type !== "text") return
          expect(result.value).toContain("sample.bin: 1 YARA-X match")
          expect(result.value).toContain("default:marker [test]")
          expect(result.value).toContain("$a@0x0+3")
          expect(result.value).not.toContain("$a@0x4+3")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                YaraRuntime.node,
                YaraTool.node,
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

  it.live("isolates compile failures and subsequent scans", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/sample.bin`, "abc"))
          const registry = yield* ToolRegistry.Service
          const execute = (id: string, rules: string) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_yara_retry_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name: "yara_scan", input: { path: "sample.bin", rules } },
            })
          const failed = yield* execute("call-yara-failed", "rule bad { condition: and }")
          expect(failed.type).toBe("error")
          if (failed.type === "error") expect(failed.value).toContain("syntax error")
          const retry = yield* execute("call-yara-retry", 'rule good { strings: $a = "abc" condition: $a }')
          expect(retry.type).toBe("text")
          if (retry.type === "text") expect(retry.value).toContain("default:good")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                YaraRuntime.node,
                YaraTool.node,
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

  it.live("terminates an interrupted worker and starts a clean scan", () =>
    Effect.gen(function* () {
      const yara = yield* YaraRuntime.Service
      const running = yield* yara
        .scan({
          bytes: new Uint8Array(32 * 1024 * 1024),
          rules: "rule slow { condition: for any i in (0..filesize) : (uint8(i) == 255) }",
          timeoutMs: 5_000,
          maxMatchesPerPattern: 1,
          maxRules: 1,
        })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(running)

      const retry = yield* yara.scan({
        bytes: new TextEncoder().encode("abc"),
        rules: 'rule good { strings: $a = "abc" condition: $a }',
        timeoutMs: 1_000,
        maxMatchesPerPattern: 1,
        maxRules: 1,
      })
      expect(retry.matches.map((match) => match.identifier)).toEqual(["good"])
    }).pipe(Effect.provide(AppNodeBuilder.build(YaraRuntime.node))),
  )
})
