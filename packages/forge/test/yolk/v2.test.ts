import { describe, expect } from "bun:test"
import { cp, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AgentV2 } from "@turenlabs/core/agent"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Project } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { Tool } from "@turenlabs/core/tool/tool"
import { YolkTool } from "@turenlabs/core/tool/yolk"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(await mkdtemp(path.join(os.tmpdir(), "yolk-v2-")))
await cp(path.join(import.meta.dir, "fixtures/top10"), directory, { recursive: true })

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolInterceptor.node, SessionToolProvider.node, YolkTool.node]),
    [
      [ExtensionRuntime.node, Layer.mock(ExtensionRuntime.Service, { enabled: () => Effect.succeed(true) })],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory,
            project: { id: Project.ID.make("yolk-v2"), directory },
          }),
        ),
      ],
      [ToolOutputStore.node, outputStore],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_yolk_v2")
const target = {
  sessionID,
  model: ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }),
  directory,
}
const toolIdentity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_yolk_v2"),
}
const materialize = (registry: ToolRegistry.Interface) =>
  SessionToolProvider.Service.use((providers) =>
    providers.forExecution(target).pipe(Effect.flatMap((session) => registry.materialize({ session }))),
  )
const toolDefinitions = (registry: ToolRegistry.Interface) =>
  materialize(registry).pipe(Effect.map((materialized) => materialized.definitions))
const settleTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  materialize(registry).pipe(Effect.flatMap((materialized) => materialized.settle({ ...input, inline: true })))

describe("Yolk V2 runtime", () => {
  it.effect("exposes inspect_change and annotates V2 edits when the setting is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("inspect_change")

      const discovery = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "discover",
          name: "inspect_change",
          input: { path: "typescript/auth.ts" },
        },
      })
      expect(discovery.result.type).toBe("text")
      expect(discovery.result.value).toContain("typescript.auth.isInternal")

      const suggested = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "suggest",
          name: "inspect_change",
          input: { symbol: "isIntern" },
        },
      })
      expect(suggested.result.type).toBe("text")
      expect(suggested.result.value).toContain("typescript.auth.isInternal")

      const inspected = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "inspect",
          name: "inspect_change",
          input: { symbol: "typescript.auth.isInternal" },
        },
      })
      expect(inspected.result.type).toBe("text")
      expect(inspected.result.value).toContain('"target": "typescript.auth.isInternal"')
      expect(inspected.result.value).toContain('"recommendedActions"')

      const batch = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "batch",
          name: "inspect_change",
          input: { symbols: ["typescript.auth.isInternal", "typescript.permissions.canAccess"] },
        },
      })
      expect(batch.result.type).toBe("text")
      expect(batch.result.value).toContain('"mode": "batch-impact"')
      expect(batch.result.value).toContain('"target": "typescript.permissions.canAccess"')

      const target = path.join(directory, "typescript/auth.ts")
      const content = (yield* Effect.promise(() => Bun.file(target).text())).replace("@corp.com", "@external.com")
      yield* registry.register({
        edit: Tool.make({
          description: "Edit fixture",
          input: Schema.Struct({ content: Schema.String }),
          output: Schema.String,
          execute: (input) => Effect.promise(() => Bun.write(target, input.content)).pipe(Effect.as("edited")),
          toModelOutput: ({ output }) => [{ type: "text", text: output }],
        }),
      })
      const edited = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "edit", name: "edit", input: { content } },
      })

      expect(edited.result.type).toBe("content")
      expect(JSON.stringify(edited.result.value)).toContain("Yolk semantic change check")
      expect(JSON.stringify(edited.result.value)).toContain("typescript.auth.isInternal: semantic-change")

      yield* registry.register({
        apply_patch: Tool.make({
          description: "Partially failing patch fixture",
          input: Schema.Struct({ content: Schema.String }),
          output: Schema.String,
          execute: (input) =>
            Effect.promise(() => Bun.write(target, input.content)).pipe(
              Effect.flatMap(() => Effect.fail(new Tool.Failure({ message: "later patch operation failed" }))),
            ),
          toModelOutput: ({ output }) => [{ type: "text", text: output }],
        }),
      })
      const failed = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "partial-patch",
          name: "apply_patch",
          input: { content: content.replace("@external.com", "@partial.com") },
        },
      })
      expect(failed.result.type).toBe("error")
      expect(String(failed.result.value)).toContain("later patch operation failed")
      expect(String(failed.result.value)).toContain("Yolk semantic change check")
    }),
  )
})
