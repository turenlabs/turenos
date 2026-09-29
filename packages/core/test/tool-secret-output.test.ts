import { describe, expect } from "bun:test"
import { ToolFailure } from "@turenlabs/llm"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import { Database } from "@turenlabs/core/database/database"
import { ToolExecutionTable } from "@turenlabs/core/tool/execution.sql"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolInterceptor.node, ExtensionRuntime.node, Database.node]),
    [[ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig]],
  ),
)
const stored = (callID: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db
      .select()
      .from(ToolExecutionTable)
      .where(eq(ToolExecutionTable.call_id, callID))
      .all()
      .pipe(Effect.orDie)
  })
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
      expect(result.output?.content).toEqual([
        { type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png" },
        { type: "text", text: `before ${SecretRedaction.text(secret)}` },
        { type: "text", text: " after" },
      ])
    }),
  )
  it.effect("keeps text after an attachment in order when a credential is split around it", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
      yield* registry.register({
        split: Tool.make({
          description: "Return a credential split around an attachment",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("ok"),
          toModelOutput: () => [
            { type: "text", text: `before ${secret.slice(0, 12)}` },
            { type: "file", mime: "image/png", data },
            { type: "text", text: `${secret.slice(12)} after` },
          ],
        }),
      })
      const result = yield* settleTool(registry, call("split", "split"))
      expect(JSON.stringify(result).includes(secret)).toBe(false)
      expect(JSON.stringify(result).includes(secret.slice(12))).toBe(false)
      expect(result.output?.content).toEqual([
        { type: "text", text: `before ${SecretRedaction.text(secret)}` },
        { type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png" },
        { type: "text", text: " after" },
      ])
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

  it.effect("masks a whole configured value in a tool failure before legacy error formatting", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const extensions = yield* ExtensionRuntime.Service
      // A configured composite whose first half is also a detected format: formatting first used to
      // replace only that half, leaving the configured value unmatchable and its secret half exposed.
      const composite = `AKIA${"Q7".repeat(8)}:synthetic/Private+Suffix92837`
      yield* extensions.update(
        Extension.ID.make("turenlabs", "pagerduty"),
        { enabled: false, secrets: { PAGERDUTY_CLIENT_SECRET: composite } },
        { local: true },
      )
      yield* registry.register({
        failing: Tool.make({
          description: "Fail with a configured composite credential",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.fail(new ToolFailure({ message: `failure ${composite} at /Users/someone/work/file` })),
        }),
      })
      const result = yield* settleTool(registry, call("failing", "composite-error"))
      const rows = yield* stored("composite-error")
      expect(rows).toHaveLength(1)
      for (const retained of [JSON.stringify(result), JSON.stringify(rows)]) {
        expect(retained).not.toContain("Private+Suffix92837")
        expect(retained).not.toContain("AKIA")
        expect(retained).toMatch(/failure \[SECRET:v1:known:[a-f0-9]{32}\]/)
        // Legacy diagnostics still apply to the rest of the message.
        expect(retained).toContain("$HOME/work/file")
      }
    }),
  )

  it.effect("masks a detected credential before the error length cap can cut it", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const token = `glpat-${"Q7a9".repeat(5)}`
      yield* registry.register({
        verbose: Tool.make({
          description: "Fail with a long message",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Effect.fail(new ToolFailure({ message: `${"x".repeat(4060)} ${token}${" trailing context".repeat(20)}` })),
        }),
      })
      const result = yield* settleTool(registry, call("verbose", "cut-error"))
      const rows = yield* stored("cut-error")
      for (const retained of [JSON.stringify(result), JSON.stringify(rows)]) {
        expect(retained).not.toContain(token.slice(0, 12))
        expect(retained).toContain("[error truncated]")
      }
      // The cap never leaves half a reference behind.
      if (result.result.type === "error" && typeof result.result.value === "string")
        expect(result.result.value).not.toMatch(/\[SECRET:v1:[a-z0-9-]*(:[a-f0-9]{0,31})?…/)
    }),
  )

  it.effect("keeps existing references intact through legacy error formatting", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        leaking: Tool.make({
          description: "Fail with a detected credential",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.fail(new ToolFailure({ message: `secret: ${secret} token=${secret}` })),
        }),
      })
      const result = yield* settleTool(registry, call("leaking", "reference-error"))
      expect(JSON.stringify(result)).not.toContain(secret)
      // `secret:` / `token=` rewriting must not mangle the stable reference into `[SECRET:[redacted]`.
      expect(JSON.stringify(result.result)).toMatch(/secret: \[SECRET:v1:github:[a-f0-9]{32}\]/)
      expect(JSON.stringify(result.result)).toMatch(/token=\[SECRET:v1:github:[a-f0-9]{32}\]/)
    }),
  )
})
