import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Storage } from "@turenlabs/core/storage"
import { BatouTool } from "@turenlabs/core/tool/batou"
import { BatouScanner } from "@turenlabs/core/tool/batou-scanner"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const executions: unknown[] = []
const scanner = Layer.succeed(
  BatouScanner.Service,
  BatouScanner.Service.of({
    before: (event) =>
      Effect.succeed(
        typeof event.input === "object" &&
          event.input !== null &&
          "content" in event.input &&
          event.input.content === "block"
          ? "Batou blocked a high-risk write"
          : undefined,
      ),
    after: () => Effect.succeed(["Batou found an advisory issue"]),
  }),
)
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolInterceptor.node, BatouTool.node, ExtensionRuntime.node, Storage.node]),
    [
      [BatouScanner.node, scanner],
      [ToolOutputStore.node, outputStore],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_batou")
const write = Tool.make({
  description: "Write",
  input: Schema.Struct({ path: Schema.String, content: Schema.String }),
  output: Schema.String,
  execute: (input) => Effect.sync(() => executions.push(input)).pipe(Effect.as("written")),
  toModelOutput: ({ output }) => [{ type: "text", text: output }],
})
const call = (content: string, id: string): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call", id, name: "write", input: { path: "src/index.ts", content } },
})

describe("BatouTool", () => {
  it.effect("denies V2 writes only while the Extension is enabled", () =>
    Effect.gen(function* () {
      executions.length = 0
      const registry = yield* ToolRegistry.Service
      const extensions = yield* ExtensionRuntime.Service
      yield* registry.register({ write })

      yield* extensions.update("turenlabs/batou", { enabled: false })
      expect((yield* settleTool(registry, call("block", "disabled"))).result).toEqual({
        type: "text",
        value: "written",
      })

      yield* extensions.update("turenlabs/batou", { enabled: true })
      expect((yield* settleTool(registry, call("block", "enabled"))).result).toEqual({
        type: "error",
        value: "Batou blocked a high-risk write",
      })
      expect(executions).toEqual([{ path: "src/index.ts", content: "block" }])
    }),
  )

  it.effect("appends advisory findings after an allowed V2 write", () =>
    Effect.gen(function* () {
      executions.length = 0
      const registry = yield* ToolRegistry.Service
      const extensions = yield* ExtensionRuntime.Service
      yield* registry.register({ write })
      yield* extensions.update("turenlabs/batou", { enabled: true })

      const settlement = yield* settleTool(registry, call("safe", "allowed"))
      expect(settlement.result).toEqual({
        type: "content",
        value: [
          { type: "text", text: "written" },
          { type: "text", text: "Batou found an advisory issue" },
        ],
      })
      expect(executions).toEqual([{ path: "src/index.ts", content: "safe" }])
    }),
  )

  it.effect("forgets a scanned write the registry refuses before it runs", () =>
    Effect.gen(function* () {
      executions.length = 0
      const registry = yield* ToolRegistry.Service
      const extensions = yield* ExtensionRuntime.Service
      yield* registry.register({ write })
      yield* extensions.update("turenlabs/batou", { enabled: true })

      const masked = yield* settleTool(registry, call(`[SECRET:v1:github:${"a".repeat(32)}]`, "reused"))
      expect(masked.result.type).toBe("error")

      // A later call with the same call ID, in another message, must not inherit the refused call's scan.
      yield* extensions.update("turenlabs/batou", { enabled: false })
      const later = yield* settleTool(registry, {
        ...call("safe", "reused"),
        assistantMessageID: SessionMessage.ID.make("msg_batou_later"),
      })
      expect(later.result).toEqual({ type: "text", value: "written" })
      expect(executions).toEqual([{ path: "src/index.ts", content: "safe" }])
    }),
  )
})
