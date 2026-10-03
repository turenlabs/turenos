import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { runInNewContext } from "node:vm"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ScriptDeobfuscateRuntime } from "@turenlabs/core/tool/script-deobfuscate-runtime"
import { ScriptDeobfuscateTools } from "@turenlabs/core/tool/script-deobfuscate-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const permission = (deny = false, observed: PermissionV2.AssertInput[] = []) =>
  Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: (input) =>
        Effect.sync(() => {
          observed.push(input)
        }).pipe(
          Effect.andThen(
            deny
              ? Effect.fail(
                  new PermissionV2.BlockedError({ rules: [{ action: input.action, resource: "*", effect: "deny" }] }),
                )
              : Effect.void,
          ),
        ),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
const fixtureLayer = (
  tmp: { path: string },
  deny = false,
  overrides: Parameters<typeof AppNodeBuilder.build>[1] = [],
  observed: PermissionV2.AssertInput[] = [],
) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      LocationMutation.node,
      ScriptDeobfuscateRuntime.node,
      ScriptDeobfuscateTools.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
      ],
      [PermissionV2.node, permission(deny, observed)],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ...overrides,
    ],
  )
const withTemp = <A, E, R>(use: (tmp: Awaited<ReturnType<typeof tmpdir>>) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    use,
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
const call = (registry: ToolRegistry.Interface, id: string, input: Record<string, unknown>) =>
  executeTool(registry, {
    sessionID: SessionV2.ID.make("ses_script_deobfuscate_test"),
    ...toolIdentity,
    call: { type: "tool-call", id, name: "script_deobfuscate", input },
  })

describe("ScriptDeobfuscateRuntime and ScriptDeobfuscateTools (real packaged WASM)", () => {
  it.live("returns bounded reports, preserves trusted JS semantics, and rejects malformed/unsupported input", () =>
    withTemp((tmp) =>
      Effect.gen(function* () {
        const runtime = yield* ScriptDeobfuscateRuntime.Service
        // Only this authored fixture is evaluated, never arbitrary analyzed input or recovered payloads.
        const source = '("he" + "llo") + (2 * 3);'
        const result = yield* runtime.run({ bytes: new TextEncoder().encode(source), options: { language: "js" } })
        expect(result.schema_version).toBe(1)
        expect(result.input.sha256).toBe(createHash("sha256").update(source).digest("hex"))
        expect(result.transformations.length).toBeGreaterThan(0)
        expect(runInNewContext(result.code, Object.create(null), { timeout: 1000 })).toBe(
          runInNewContext(source, Object.create(null), { timeout: 1000 }),
        )
        for (const span of result.transformations) {
          expect(span.start).toBeGreaterThanOrEqual(0)
          expect(span.end).toBeGreaterThanOrEqual(span.start)
          expect(span.end).toBeLessThanOrEqual(Buffer.byteLength(source))
        }
        const empty = yield* runtime.run({ bytes: new Uint8Array(), options: {} })
        expect(empty.input.bytes).toBe(0)
        const malformed = yield* runtime
          .run({ bytes: new TextEncoder().encode("const = ;"), options: {} })
          .pipe(Effect.exit)
        expect(malformed._tag).toBe("Failure")
        const oversized = yield* runtime.run({ bytes: new Uint8Array(1024 * 1024 + 1), options: {} }).pipe(Effect.exit)
        expect(oversized._tag).toBe("Failure")
        const dynamic = yield* runtime.run({ bytes: new TextEncoder().encode("unknown(value);"), options: {} })
        expect(dynamic.code).toContain("unknown")
        yield* Effect.promise(() => Bun.write(`${tmp.path}/valid.js`, source))
        yield* Effect.promise(() => Bun.write(`${tmp.path}/bad.js`, "const = ;"))
        yield* Effect.promise(() => Bun.write(`${tmp.path}/empty.js`, ""))
        const registry = yield* ToolRegistry.Service
        const emptyFile = yield* call(registry, "empty-file", { path: "empty.js" })
        expect(emptyFile.type).toBe("text")
        if (emptyFile.type === "text") {
          const report = JSON.parse(String(emptyFile.value)) as {
            input: { bytes: number }
            code: { artifactPath: string; bytes: number }
          }
          expect(report.input.bytes).toBe(0)
          expect(report.code.bytes).toBe(0)
          expect((yield* Effect.promise(() => fs.readFile(report.code.artifactPath))).length).toBe(0)
        }
        expect((yield* call(registry, "unsupported-language", { path: "valid.js", language: "python" })).type).toBe(
          "error",
        )
        expect((yield* call(registry, "invalid-option", { path: "valid.js", extractPayloads: "yes" })).type).toBe(
          "error",
        )
        expect((yield* call(registry, "malformed", { path: "bad.js", language: "js" })).type).toBe("error")
      }).pipe(Effect.provide(fixtureLayer(tmp))),
    ),
  )

  it.live("writes readable code and recovered payload artifacts without inlining payload code", () =>
    withTemp((tmp) =>
      Effect.gen(function* () {
        const source = 'eval("console.log(\\"recovered-payload\\")");'
        yield* Effect.promise(() => Bun.write(`${tmp.path}/payload.js`, source))
        const registry = yield* ToolRegistry.Service
        const output = yield* call(registry, "payload", { language: "js", path: "payload.js", extractPayloads: true })
        expect(output.type).toBe("text")
        if (output.type !== "text") return
        const report = JSON.parse(String(output.value)) as {
          code: { artifactPath: string; bytes: number; sha256: string; preview: string }
          payloads: { artifactPath: string; sha256: string; code?: string }[]
          assumptions: string[]
        }
        expect(report.payloads.length).toBeGreaterThan(0)
        expect(Buffer.byteLength(report.code.preview)).toBeLessThanOrEqual(4096)
        const code = yield* Effect.promise(() => fs.readFile(report.code.artifactPath))
        expect(code.length).toBe(report.code.bytes)
        expect(createHash("sha256").update(code).digest("hex")).toBe(report.code.sha256)
        for (const payload of report.payloads) {
          expect(payload.code).toBeUndefined()
          const bytes = yield* Effect.promise(() => fs.readFile(payload.artifactPath))
          expect(bytes.toString()).toContain("recovered-payload")
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(payload.sha256)
        }
        expect(report.assumptions).toEqual([])
        const disabled = yield* call(registry, "payload-disabled", { path: "payload.js" })
        expect(disabled.type).toBe("text")
        if (disabled.type === "text") expect(JSON.parse(String(disabled.value)).payloads).toEqual([])
        yield* Effect.promise(() => Bun.write(`${tmp.path}/unicode.js`, `//${"😀".repeat(2000)}\n1 + 2;`))
        const unicode = yield* call(registry, "unicode-preview", { path: "unicode.js", assumeStandardBuiltins: true })
        expect(unicode.type).toBe("text")
        if (unicode.type === "text") {
          const bounded = JSON.parse(String(unicode.value)) as {
            code: { preview: string; previewTruncated: boolean }
            assumptions: string[]
          }
          expect(Buffer.byteLength(bounded.code.preview)).toBeLessThanOrEqual(4096)
          expect(bounded.code.preview).not.toContain("\ufffd")
          expect(bounded.code.previewTruncated).toBe(true)
          expect(bounded.assumptions.length).toBe(1)
        }
      }).pipe(Effect.provide(fixtureLayer(tmp))),
    ),
  )

  it.live("local and external-directory permission denial reaches neither runtime nor artifact storage", () =>
    withTemp((tmp) =>
      withTemp((external) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/denied.js`, "1 + 2;"))
          yield* Effect.promise(() => Bun.write(`${external.path}/denied.js`, "1 + 2;"))
          const calls = { workers: 0, writes: 0 }
          const observed: PermissionV2.AssertInput[] = []
          // Fail-fast dependency guards only for the denied path; all analysis tests above use the real WASM runtime.
          const runtime = Layer.succeed(
            ScriptDeobfuscateRuntime.Service,
            ScriptDeobfuscateRuntime.Service.of({
              run: () =>
                Effect.sync(() => {
                  calls.workers++
                  throw new Error("permission must precede worker")
                }),
            }),
          )
          const artifacts = Layer.succeed(
            ToolOutputStore.Service,
            ToolOutputStore.Service.of({
              limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
              bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
              writeBytes: () =>
                Effect.sync(() => {
                  calls.writes++
                  throw new Error("permission must precede artifact")
                }),
              cleanup: () => Effect.void,
            }),
          )
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* call(registry, "denied", { path: "denied.js" })).type).toBe("error")
            expect((yield* call(registry, "external-denied", { path: `${external.path}/denied.js` })).type).toBe(
              "error",
            )
            expect(calls).toEqual({ workers: 0, writes: 0 })
            expect(observed.map((request) => request.action)).toEqual(["script_deobfuscate", "external_directory"])
            expect(observed[0].source).toEqual({
              type: "tool",
              messageID: toolIdentity.assistantMessageID,
              callID: "denied",
            })
            expect(observed[1].source).toEqual({
              type: "tool",
              messageID: toolIdentity.assistantMessageID,
              callID: "external-denied",
            })
          }).pipe(
            Effect.provide(
              fixtureLayer(
                tmp,
                true,
                [
                  [ScriptDeobfuscateRuntime.node, runtime],
                  [ToolOutputStore.node, artifacts],
                ],
                observed,
              ),
            ),
          )
        }),
      ),
    ),
  )

  it.live("interruption does not strand the single permit or the next fresh worker", () =>
    withTemp((tmp) =>
      Effect.gen(function* () {
        const runtime = yield* ScriptDeobfuscateRuntime.Service
        const fiber = yield* runtime
          .run({ bytes: new TextEncoder().encode("/*" + "x".repeat(900_000) + "*/1 + 2;"), options: {} })
          .pipe(Effect.forkChild)
        yield* Effect.sleep("1 millis")
        yield* Fiber.interrupt(fiber)
        const next = yield* runtime.run({ bytes: new TextEncoder().encode("1 + 2;"), options: {} })
        expect(next.language).toBe("js")
      }).pipe(Effect.provide(fixtureLayer(tmp))),
    ),
  )
})
