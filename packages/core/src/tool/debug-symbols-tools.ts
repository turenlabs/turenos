export * as DebugSymbolsTools from "./debug-symbols-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { DebugSymbolsRuntime } from "./debug-symbols-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RECORDS = 4096
const Path = Schema.NonEmptyString.annotate({ description: "Object file, ELF/Mach-O/PE, or PDB file to inspect." })
const Input = Schema.Struct({
  path: Path,
  format: Schema.Literals(["auto", "dwarf", "pdb"]).pipe(Schema.optional).annotate({
    description: "Debug format. Defaults to auto-detection.",
  }),
  demangle: Schema.Boolean.pipe(Schema.optional).annotate({ description: "Demangle Rust, C++, and MSVC names." }),
  sourcePaths: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include source-path fields when available. Defaults to false.",
  }),
  maxRecords: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RECORDS)).pipe(Schema.optional).annotate({
    description: `Maximum symbols/sections to return. Defaults to ${MAX_RECORDS}.`,
  }),
})
const Output = Schema.Struct({ path: Schema.String, report: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* DebugSymbolsRuntime.Service
    yield* tools
      .register({
        debug_symbols: Tool.make({
          deferred: true,
          description:
            "Inspect bounded DWARF sections, PDB public symbols, object symbols, and demangled names with the bundled WebAssembly parser. Source paths are omitted by default; the target is never executed.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "debug_symbols", context, mutation, fs, permission)
              const result = yield* runtime
                .inspect({
                  bytes: file.bytes,
                  options: {
                    demangle: input.demangle ?? true,
                    source_paths: input.sourcePaths ?? false,
                    max_records: input.maxRecords ?? MAX_RECORDS,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to inspect ${input.path}: ${error.message}` })))
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to inspect ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/debug-symbols",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, DebugSymbolsRuntime.node],
})
