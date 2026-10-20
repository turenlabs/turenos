import { describe, expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Global } from "@turenlabs/core/global"
import { PermissionV2 } from "@turenlabs/core/permission"
import { SessionV2 } from "@turenlabs/core/session"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { ToolResultStore } from "@turenlabs/core/tool-result-store"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ResultTools } from "@turenlabs/core/tool/results"
import { Tool } from "@turenlabs/core/tool/tool"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_result_tools")
const foreignID = SessionV2.ID.make("ses_result_tools_foreign")
const it = testEffect(Layer.empty)

function withSystem<A, E, R>(
  body: (input: {
    registry: ToolRegistry.Interface
    store: ToolResultStore.Interface
    assertions: PermissionV2.AssertInput[]
    policy: { deny: boolean }
    root: string
  }) => Effect.Effect<A, E, R>,
  protection: SecretOutput.Interface["snapshot"] = () => Effect.succeed(SecretRedaction),
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const assertions: PermissionV2.AssertInput[] = []
      const policy = { deny: false }
      return Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const store = yield* ToolResultStore.Service
        return yield* body({ registry, store, assertions, policy, root: tmp.path })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ResultTools.node, ToolResultStore.node]),
            [
              [Global.node, Global.layerWith({ data: tmp.path })],
              [Database.node, Database.layerFromPath(":memory:")],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              [
                SecretOutput.node,
                Layer.succeed(SecretOutput.Service, SecretOutput.Service.of({ snapshot: protection })),
              ],
              [
                PermissionV2.node,
                Layer.succeed(
                  PermissionV2.Service,
                  PermissionV2.Service.of({
                    assert: (input) =>
                      Effect.suspend(() => {
                        assertions.push(input)
                        return policy.deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void
                      }),
                    ask: () => Effect.die("unused"),
                    reply: () => Effect.die("unused"),
                    get: () => Effect.die("unused"),
                    forSession: () => Effect.die("unused"),
                    list: () => Effect.die("unused"),
                  }),
                ),
              ],
            ],
          ),
        ),
      )
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

const invoke = (
  registry: ToolRegistry.Interface,
  name: string,
  input: Record<string, unknown>,
  id: string,
  owner = sessionID,
) => settleTool(registry, { sessionID: owner, ...toolIdentity, call: { type: "tool-call", name, id, input } })

describe("retained result tool flow", () => {
  it.live(
    "captures large structured data independently of a useful small initial view and computes without rerunning",
    () =>
      withSystem(({ registry, store }) =>
        Effect.gen(function* () {
          const rows = Array.from({ length: 512 }, (_, index) => ({ value: index, note: "detail ".repeat(30) }))
          const executions: number[] = []
          yield* registry.register({
            fixture: Tool.make({
              description: "Large structured fixture",
              input: Schema.Struct({}),
              output: Schema.Array(Schema.Struct({ value: Schema.Number, note: Schema.String })),
              execute: () =>
                Effect.sync(() => {
                  executions.push(1)
                  return rows
                }),
              toModelOutput: () => [{ type: "text", text: "512 records available" }],
            }),
          })
          const captured = yield* invoke(registry, "fixture", {}, "call-capture")
          const reference = ToolResultStore.referenceOf(captured.output?.structured)
          expect(reference).toBeDefined()
          if (!reference) throw new Error("capture reference missing")
          expect(captured.result.type).toBe("content")
          expect(JSON.stringify(captured.result).length).toBeLessThan(1500)
          expect((yield* store.get({ sessionID, id: reference.id })).structured).toEqual(rows)
          const repeated = yield* invoke(registry, "fixture", {}, "call-capture")
          expect(repeated).toEqual(captured)
          const computed = yield* invoke(
            registry,
            "result_compute",
            {
              id: reference.id,
              code: "return { count: data.length, sum: data.reduce((sum, row) => sum + row.value, 0) }",
            },
            "call-compute",
          )
          expect(computed.output?.structured).toEqual({
            resultID: reference.id,
            channel: "structured",
            computation: { ok: true, value: { count: 512, sum: 130816 }, toolCalls: [] },
          })
          expect(executions).toEqual([1])
          expect(yield* store.list({ sessionID })).toMatchObject({ results: [reference], incomplete: false })
        }),
      ),
  )

  it.live("reads exact UTF-8 byte fragments without replacement and bounds literal search with coverage", () =>
    withSystem(({ registry, store }) =>
      Effect.gen(function* () {
        const reference = yield* store.put({
          sessionID,
          tool: "fixture",
          toolCallID: "source",
          text: "🙂雪\u0000 needle\nneedle",
          structured: [2, 4, 8],
        })
        const bytes = Buffer.from("🙂雪\u0000 needle\nneedle")
        const pages: Buffer[] = []
        for (const offset of Array.from({ length: Math.ceil(bytes.length / 3) }, (_, index) => index * 3)) {
          const page = yield* invoke(
            registry,
            "result_read",
            { id: reference.id, offset, maxBytes: 3 },
            `page-${offset}`,
          )
          const output = Schema.decodeUnknownSync(
            Schema.Struct({
              content: Schema.String,
              encoding: Schema.Literals(["utf8", "base64"]),
              totalBytes: Schema.Number,
            }),
          )(page.output?.structured)
          pages.push(Buffer.from(output.content, output.encoding === "utf8" ? "utf8" : "base64"))
          expect(output.totalBytes).toBe(bytes.length)
        }
        expect(Buffer.concat(pages)).toEqual(bytes)
        const found = yield* invoke(
          registry,
          "result_search",
          { id: reference.id, query: "needle", limit: 1 },
          "search",
        )
        expect(found.output?.structured).toMatchObject({
          matches: 2,
          complete: true,
          hits: [{ offset: 9, excerpt: "needle\nneedle" }],
        })
        const json = yield* invoke(registry, "result_read", { id: reference.id, channel: "structured" }, "read-json")
        expect(json.output?.structured).toMatchObject({ content: "[2,4,8]", encoding: "utf8" })
        const large = yield* store.put({ sessionID, tool: "fixture", toolCallID: "many", text: "x".repeat(10001) })
        const partial = yield* invoke(registry, "result_search", { id: large.id, query: "x" }, "search-many")
        expect(partial.output?.structured).toMatchObject({ matches: 10000, complete: false })
        const missing = yield* invoke(
          registry,
          "result_search",
          { id: large.id, query: "x", channel: "structured" },
          "search-missing-channel",
        )
        expect(missing.result).toMatchObject({ type: "error", value: "This capture has no structured channel." })
      }),
    ),
  )

  it.live("enforces canonical session scope and read permission even for direct calls", () =>
    withSystem(({ registry, store, assertions, policy }) =>
      Effect.gen(function* () {
        const reference = yield* store.put({
          sessionID,
          tool: "fixture",
          toolCallID: "source",
          text: "private capture",
        })
        expect((yield* invoke(registry, "result_list", {}, "foreign-list", foreignID)).output?.structured).toEqual({
          results: [],
          incomplete: false,
        })
        const foreign = yield* invoke(registry, "result_read", { id: reference.id }, "foreign-read", foreignID)
        expect(foreign.result).toEqual({ type: "error", value: "Retained tool result is unavailable." })
        policy.deny = true
        for (const name of ["result_list", "result_read", "result_search", "result_compute"]) {
          const input = name === "result_list" ? {} : { id: reference.id, query: "private", code: "return data" }
          expect((yield* invoke(registry, name, input, `deny-${name}`)).result.type).toBe("error")
        }
        expect(assertions.every((input) => input.action === "read" && input.source?.type === "tool")).toBe(true)
        expect(assertions.at(-1)).toMatchObject({
          sessionID,
          source: { messageID: toolIdentity.assistantMessageID, callID: "deny-result_compute" },
        })
        expect(
          (yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).map(
            (tool) => tool.name,
          ),
        ).toEqual([])
      }),
    ),
  )

  it.live("keeps successful source execution durable when an optional capture exceeds its quota", () =>
    withSystem(({ registry }) =>
      Effect.gen(function* () {
        const executions: number[] = []
        yield* registry.register({
          mutation: Tool.make({
            description: "Already completed mutation",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => {
                executions.push(1)
                return "x".repeat(ToolResultStore.MAX_BYTES + 1)
              }),
          }),
        })
        const first = yield* invoke(registry, "mutation", {}, "large-mutation")
        expect(first.result.type).toBe("text")
        expect(JSON.stringify(first.result)).toContain("Retained capture unavailable")
        expect(JSON.stringify(first.result)).toContain("source tool already completed")
        expect(ToolResultStore.referenceOf(first.output?.structured)).toBeUndefined()
        expect(yield* invoke(registry, "mutation", {}, "large-mutation")).toEqual(first)
        expect(executions).toEqual([1])
      }),
    ),
  )

  it.live(
    "bounds hostile structured output before capture and keeps completed operations retryable by identity only",
    () =>
      withSystem(({ registry }) =>
        Effect.gen(function* () {
          const executions: number[] = []
          const deep: Record<string, unknown> = {}
          let child = deep
          for (let index = 0; index < 20_000; index++) {
            const next = {}
            child.next = next
            child = next
          }
          let graph: Record<string, unknown> = { leaf: 1 }
          for (let index = 0; index < 40; index++) graph = { left: graph, right: graph }
          for (const [index, value] of [deep, graph].entries()) {
            yield* registry.register({
              [`hostile${index}`]: Tool.make({
                description: "Successful operation with unsupported structured output",
                input: Schema.Struct({}),
                output: Schema.Unknown,
                execute: () =>
                  Effect.sync(() => {
                    executions.push(index)
                    return value
                  }),
                toModelOutput: () => [{ type: "text", text: "Source operation completed." }],
              }),
            })
            const first = yield* invoke(registry, `hostile${index}`, {}, `hostile-${index}`)
            expect(first.result.type).not.toBe("error")
            expect(first.output?.structured).toHaveProperty("retentionUnavailable")
            expect(ToolResultStore.referenceOf(first.output?.structured)?.captureTruncated).toBe(true)
            expect(yield* invoke(registry, `hostile${index}`, {}, `hostile-${index}`)).toEqual(first)
          }
          expect(executions).toEqual([0, 1])
        }),
      ),
  )

  it.live("protects JSON and joined text credentials before retained disk, read, and compute access", () => {
    const secret = "opaque.cobalt.river.92837"
    const detected = `ghp_${"aB12".repeat(9)}`
    const protection = SecretRedaction.compile([secret])
    return withSystem(
      ({ registry, store, root }) =>
        Effect.gen(function* () {
          yield* registry.register({
            secret_fixture: Tool.make({
              description: "Synthetic credential-bearing output",
              input: Schema.Struct({}),
              output: Schema.Struct({ credential: Schema.String, detected: Schema.String, note: Schema.String }),
              execute: () => Effect.succeed({ credential: secret, detected, note: "ordinary evidence ".repeat(4000) }),
              toModelOutput: () => [
                { type: "text", text: `credential ${secret.slice(0, 12)}` },
                { type: "file", mime: "text/plain", data: "b3BhcXVl", name: secret },
                { type: "text", text: `${secret.slice(12)}\n${detected}\n${"ordinary evidence ".repeat(4000)}` },
              ],
            }),
          })
          const captured = yield* invoke(registry, "secret_fixture", {}, "secret-capture")
          const reference = ToolResultStore.referenceOf(captured.output?.structured)
          if (!reference) throw new Error("protected capture reference missing")
          const snapshot = yield* store.get({ sessionID, id: reference.id })
          expect(captured.output?.content.find((part) => part.type === "file")?.name).toBe(protection.text(secret))
          expect(snapshot.text).toContain("[SECRET:v1:")
          expect(snapshot.structured).toMatchObject({
            credential: protection.text(secret),
            detected: protection.text(detected),
          })
          const retainedFile = yield* Effect.promise(() =>
            Bun.file(
              path.join(
                root,
                ToolResultStore.MANAGED_DIRECTORY,
                createHash("sha256").update(sessionID).digest("hex"),
                reference.id,
              ),
            ).text(),
          )
          const overflow = yield* Effect.promise(() => Bun.file(captured.outputPaths![0]!).text())
          const read = yield* invoke(registry, "result_read", { id: reference.id }, "secret-read")
          const json = yield* invoke(
            registry,
            "result_read",
            { id: reference.id, channel: "structured" },
            "secret-json",
          )
          const computed = yield* invoke(
            registry,
            "result_compute",
            { id: reference.id, code: "return { credential: data.credential, detected: data.detected }" },
            "secret-compute",
          )
          const text = yield* invoke(
            registry,
            "result_compute",
            { id: reference.id, channel: "text", code: "return data.slice(0, 160)" },
            "secret-compute-text",
          )
          for (const value of [
            JSON.stringify(captured),
            JSON.stringify(snapshot),
            retainedFile,
            overflow,
            JSON.stringify(read),
            JSON.stringify(json),
            JSON.stringify(computed),
            JSON.stringify(text),
          ]) {
            expect(value).not.toContain(secret)
            expect(value).not.toContain(secret.slice(12))
            expect(value).not.toContain(detected)
          }
          expect(computed.output?.structured).toMatchObject({
            computation: {
              ok: true,
              value: { credential: protection.text(secret), detected: protection.text(detected) },
            },
          })
          expect(text.output?.structured).toMatchObject({ computation: { ok: true } })
        }),
      () => Effect.succeed(protection),
    )
  })

  it.live("withholds execution when secret protection cannot be acquired", () =>
    withSystem(
      ({ registry, store }) =>
        Effect.gen(function* () {
          const executions: number[] = []
          yield* registry.register({
            mutation: Tool.make({
              description: "Mutation must not start without output protection",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () =>
                Effect.sync(() => {
                  executions.push(1)
                  return "completed"
                }),
            }),
          })
          const result = yield* invoke(registry, "mutation", {}, "protection-unavailable")
          expect(result.result).toEqual({
            type: "error",
            value: "Tool execution withheld because secret output protection is unavailable",
          })
          expect(executions).toEqual([])
          expect(yield* store.list({ sessionID })).toEqual({ results: [], incomplete: false })
        }),
      () => Effect.fail(new SecretOutput.Error({ message: "Secret output protection unavailable" })),
    ),
  )

  it.live("withholds output instead of bypassing a strict protection failure after execution", () =>
    withSystem(({ registry, store }) =>
      Effect.gen(function* () {
        const executions: number[] = []
        const deep = Array.from({ length: 65 }).reduce<unknown>((value) => [value], "opaque.cobalt.river.92837")
        yield* registry.register({
          protected_failure: Tool.make({
            description: "JSON shape beyond the strict redaction budget",
            input: Schema.Struct({}),
            output: Schema.Unknown,
            execute: () =>
              Effect.sync(() => {
                executions.push(1)
                return deep
              }),
            toModelOutput: () => [{ type: "text", text: "Source operation completed." }],
          }),
        })
        const first = yield* invoke(registry, "protected_failure", {}, "strict-protection-failure")
        expect(first.result).toEqual({ type: "error", value: "Tool output withheld because secret redaction failed" })
        expect(yield* invoke(registry, "protected_failure", {}, "strict-protection-failure")).toEqual(first)
        expect(executions).toEqual([1])
        expect(yield* store.list({ sessionID })).toEqual({ results: [], incomplete: false })
      }),
    ),
  )

  it.live("retains MCP machine JSON independently of a tiny human-facing summary", () =>
    withSystem(({ registry, store }) =>
      Effect.gen(function* () {
        const structured = { rows: Array.from({ length: 512 }, (_, id) => ({ id, text: "evidence ".repeat(30) })) }
        const output = McpTool.toOutput({
          content: [{ type: "text", text: "512 rows available" }],
          structuredContent: structured,
        })
        yield* registry.register({
          mcp_fixture: Tool.make({
            description: "MCP translation fixture",
            input: Schema.Struct({}),
            output: McpTool.Output,
            execute: () => Effect.succeed(output),
            toModelOutput: ({ output }) => output.content,
          }),
        })
        const captured = yield* invoke(registry, "mcp_fixture", {}, "mcp-capture")
        const reference = ToolResultStore.referenceOf(captured.output?.structured)
        if (!reference) throw new Error("MCP capture reference missing")
        expect((yield* store.get({ sessionID, id: reference.id })).structured).toMatchObject({
          structuredContent: structured,
        })
        expect(JSON.stringify(captured.result).length).toBeLessThan(1500)
      }),
    ),
  )
})
