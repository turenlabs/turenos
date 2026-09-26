import { describe, expect } from "bun:test"
import { ToolFailure } from "@turenlabs/llm"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolInterceptor.node, ExtensionRuntime.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)
const secret = `ghp_${"aB12".repeat(9)}`
const call = (name: string, id: string, input: unknown = {}): ToolRegistry.ExecuteInput => ({
  sessionID: SessionV2.ID.make("ses_secret_output"),
  ...toolIdentity,
  call: { type: "tool-call", id, name, input },
})

// Synthetic credentials only; exercise the real registry and managed output files.
describe("secret-safe tool settlement", () => {
  it.effect("preserves unnamed binary attachments that incidentally match a known credential", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const registry = yield* ToolRegistry.Service
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
      yield* extensions.update(
        Extension.ID.make("turenlabs", "pagerduty"),
        { enabled: false, secrets: { PAGERDUTY_CLIENT_SECRET: "iVBORw0KGgo" } },
        { local: true },
      )
      yield* registry.register({
        attachment: Tool.make({
          description: "Return opaque synthetic image bytes",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("image"),
          toModelOutput: () => [{ type: "file", mime: "image/png", data }],
        }),
      })
      const result = yield* settleTool(registry, call("attachment", "attachment"))
      expect(result.output?.content).toEqual([
        { type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png" },
      ])
      yield* extensions.update(
        Extension.ID.make("turenlabs", "pagerduty"),
        { enabled: false, secrets: { PAGERDUTY_CLIENT_SECRET: "image/png" } },
        { local: true },
      )
      const descriptor = yield* settleTool(registry, call("attachment", "attachment-descriptor"))
      expect(descriptor.output?.content).toEqual(result.output?.content)
    }),
  )
  it.effect("does not reconstruct a credential when text parts are joined for overflow", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        fragments: Tool.make({
          description: "Return a credential across text parts",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
          toModelOutput: () => [
            { type: "text", text: secret.slice(0, 12) },
            { type: "text", text: `${secret.slice(12)}\n${"ordinary\n".repeat(8000)}` },
          ],
        }),
      })
      const result = yield* settleTool(registry, call("fragments", "fragments"))
      const retained = yield* Effect.promise(() => Bun.file(result.outputPaths![0]!).text())
      expect(retained.includes(secret)).toBe(false)
      expect(retained).toContain("[SECRET:v1:")
    }),
  )
  it.effect("keeps attachments in place when a reconstructed credential is masked in small output", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
      yield* registry.register({
        ordered: Tool.make({
          description: "Return an attachment before a credential split across text parts",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
          toModelOutput: () => [
            { type: "file", mime: "image/png", data },
            { type: "text", text: `before ${secret.slice(0, 12)}` },
            { type: "text", text: `${secret.slice(12)} after` },
          ],
        }),
      })
      const result = yield* settleTool(registry, call("ordered", "ordered"))
      expect(JSON.stringify(result).includes(secret)).toBe(false)
      expect(result.output?.content.map((item) => item.type)).toEqual(["file", "text"])
      expect(result.output?.content[1]).toMatchObject({ type: "text", text: expect.stringContaining("[SECRET:v1:") })
    }),
  )

  it.effect("masks configured extension credentials without a recognizable token format", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      const registry = yield* ToolRegistry.Service
      const opaque = "synthetic-private-extension-credential-92837"
      yield* extensions.update(
        Extension.ID.make("turenlabs", "pagerduty"),
        {
          enabled: false,
          secrets: { PAGERDUTY_CLIENT_SECRET: opaque },
        },
        { local: true },
      )
      yield* registry.register({
        configured: Tool.make({
          description: "Return a configured synthetic credential",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed(`credential=${opaque}`),
        }),
      })
      const result = yield* settleTool(registry, call("configured", "configured"))
      expect(JSON.stringify(result).includes(opaque)).toBe(false)
      expect(JSON.stringify(result)).toContain("[SECRET:v1:")
    }),
  )

  it.effect("masks structured output and overflow files before retention", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        disclosure: Tool.make({
          description: "Return a synthetic credential",
          input: Schema.Struct({}),
          output: Schema.Struct({ credential: Schema.String }),
          execute: () => Effect.succeed({ credential: secret }),
          toModelOutput: ({ output }) => [{ type: "text", text: `${output.credential}\n${"ordinary\n".repeat(8000)}` }],
        }),
      })
      const result = yield* settleTool(registry, call("disclosure", "overflow"))
      expect(JSON.stringify(result).includes(secret)).toBe(false)
      expect(JSON.stringify(result)).toContain("[SECRET:v1:")
      expect(result.outputPaths?.length).toBe(1)
      const retained = yield* Effect.promise(() => Bun.file(result.outputPaths![0]!).text())
      expect(retained.includes(secret)).toBe(false)
      expect(retained).toContain("[SECRET:v1:")
      const replayed = yield* settleTool(registry, call("disclosure", "overflow"))
      expect(replayed).toEqual(result)
    }),
  )

  it.effect("masks tool errors and interceptor notes before settlement", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const interceptors = yield* ToolInterceptor.Service
      yield* registry.register({
        failure: Tool.make({
          description: "Synthetic error",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.fail(new ToolFailure({ message: `failed: ${secret}` })),
        }),
        ordinary: Tool.make({
          description: "Ordinary output",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
        }),
      })
      yield* interceptors.hook.after((event) => {
        event.notes.push(`note: ${secret}`)
      })
      const failure = yield* settleTool(registry, call("failure", "failure"))
      expect(failure.result.type).toBe("error")
      expect(JSON.stringify(failure).includes(secret)).toBe(false)
      const ordinary = yield* settleTool(registry, call("ordinary", "notes"))
      expect(JSON.stringify(ordinary).includes(secret)).toBe(false)
      expect(JSON.stringify(ordinary)).toContain("[SECRET:v1:")
    }),
  )

  it.effect("rejects masked values before a write executes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const executions: string[] = []
      yield* registry.register({
        write: Tool.make({
          description: "Record attempted write",
          input: Schema.Struct({ content: Schema.String }),
          output: Schema.String,
          execute: (input) =>
            Effect.sync(() => {
              executions.push(input.content)
              return "written"
            }),
        }),
      })
      const result = yield* settleTool(
        registry,
        call("write", "placeholder", {
          content: `[SECRET:v1:github:${"1".repeat(32)}]`,
        }),
      )
      expect(result.result.type).toBe("error")
      const truncated = yield* settleTool(
        registry,
        call("write", "partial-placeholder", {
          content: "copied [SECRET:v1:github:123",
        }),
      )
      expect(truncated.result.type).toBe("error")
      expect(executions).toEqual([])
    }),
  )

  it.effect("refuses mutation input it cannot inspect with a tool error instead of a defect", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const executions: unknown[] = []
      yield* registry.register({
        write: Tool.make({
          description: "Record attempted write",
          input: Schema.Struct({ content: Schema.Unknown }),
          output: Schema.String,
          execute: (input) =>
            Effect.sync(() => {
              executions.push(input.content)
              return "written"
            }),
        }),
      })
      const deep = Array.from({ length: 70 }).reduce<unknown>((value) => [value], "leaf")
      const exit = yield* settleTool(registry, call("write", "uninspectable", { content: deep })).pipe(Effect.exit)
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") {
        expect(exit.value.result.type).toBe("error")
        expect(JSON.stringify(exit.value.result)).toContain("could not be checked")
      }
      expect(executions).toEqual([])
    }),
  )
})
