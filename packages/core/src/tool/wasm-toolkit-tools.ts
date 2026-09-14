export * as WasmToolkitTools from "./wasm-toolkit-tools"

import { createHash } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolOutputStore } from "../tool-output-store"
import { read } from "./binary-file"
import { WasmToolkitRuntime } from "./wasm-toolkit-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096
const MAX_WAT_BYTES = 8 * 1024 * 1024

const maxItems = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ITEMS))
  .pipe(Schema.optional)
  .annotate({ description: `Maximum entries in every reported list. Defaults to ${MAX_ITEMS}; hard maximum ${MAX_ITEMS}.` })

const FilePath = Schema.NonEmptyString.annotate({ description: "Local file to process." })
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })
const BytesOutput = Schema.Struct({
  path: Schema.String,
  artifactPath: Schema.String,
  bytes: Schema.Int,
  sha256: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* WasmToolkitRuntime.Service

    const run = Effect.fn("WasmToolkitTools.run")(function* (request: WasmToolkitRuntime.Request, path: string) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) => (error instanceof ToolFailure ? error : new ToolFailure({ message })))

    const report = Effect.fn("WasmToolkitTools.report")(function* (
      op: "wasm_analyze" | "wasm_metadata" | "wasm_print",
      options: Readonly<Record<string, unknown>>,
      path: string,
      context: Tool.Context,
    ) {
      const file = yield* read(path, op, context, mutation, fs, permission)
      const result = yield* run({ op, bytes: file.bytes, options }, path)
      if (result.type !== "report")
        return yield* new ToolFailure({ message: `${op} returned an unexpected byte result` })
      return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result.report }, null, 2) }
    })

    yield* tools
      .register({
        wasm_analyze: Tool.make({
          deferred: true,
          description:
            "Deep static profile of a local WebAssembly module or component: validation verdicts, typed imports/exports with resolved signatures, function-body statistics, required feature detection (SIMD, threads, GC, memory64, and more), custom-section inventory, and segment outlines. Parse-only — the binary is never instantiated or executed.",
          input: Schema.Struct({
            path: FilePath.annotate({ description: "Local .wasm binary to analyze." }),
            maxItems,
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("wasm_analyze", { maxItems: input.maxItems }, input.path, context).pipe(
              fail(`Unable to analyze ${input.path}`),
            ),
        }),
        wasm_metadata: Tool.make({
          deferred: true,
          description:
            "Extract metadata from a local WebAssembly binary: producers section, name-section summary, sourceMappingURL, recognized custom sections, and a component imports/exports outline. Parse-only and offline.",
          input: Schema.Struct({
            path: FilePath.annotate({ description: "Local .wasm binary to inspect." }),
            maxItems,
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("wasm_metadata", { maxItems: input.maxItems }, input.path, context).pipe(
              fail(`Unable to read metadata from ${input.path}`),
            ),
        }),
        wasm_print: Tool.make({
          deferred: true,
          description:
            "Render a local WebAssembly module or component as .wat text inside a JSON report, with optional skeleton form, folded s-expressions, and binary-offset annotations. Output is capped and reports truncation rather than materializing unbounded text.",
          input: Schema.Struct({
            path: FilePath.annotate({ description: "Local .wasm binary to disassemble." }),
            skeleton: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Print section/item structure without function bodies or data contents. Defaults to false.",
            }),
            foldExpressions: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Print instructions in folded s-expression form. Defaults to false.",
            }),
            printOffsets: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Annotate printed lines with binary offsets. Defaults to false.",
            }),
            maxWatBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_WAT_BYTES))
              .pipe(Schema.optional)
              .annotate({
                description: `Output text cap in bytes; the printer stops at the cap and reports truncation. Hard maximum ${MAX_WAT_BYTES / 1024 / 1024} MiB.`,
              }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "wasm_print",
              {
                skeleton: input.skeleton,
                foldExpressions: input.foldExpressions,
                printOffsets: input.printOffsets,
                maxWatBytes: input.maxWatBytes,
              },
              input.path,
              context,
            ).pipe(fail(`Unable to print ${input.path}`)),
        }),
        wat_compile: Tool.make({
          deferred: true,
          description:
            "Compile a local UTF-8 .wat text file (module or component) into a validated wasm binary. Useful for authoring test modules for other tooling; the produced binary is written to a retention-managed artifact. Parse errors report line, column, and byte offset.",
          input: Schema.Struct({
            path: FilePath.annotate({ description: "Local .wat text file to compile." }),
          }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte wasm binary for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "wat_compile", context, mutation, fs, permission)
              const result = yield* run({ op: "wat_compile", bytes: file.bytes, options: {} }, input.path)
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "wat_compile returned an unexpected report result" })
              return {
                path: file.resource,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to compile ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/wasm-toolkit",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    WasmToolkitRuntime.node,
  ],
})
