export * as WasmInspectTools from "./wasm-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { WasmInspectRuntime } from "./wasm-inspect-runtime"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* WasmInspectRuntime.Service
    yield* tools
      .register({
        wasm_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect and validate one WebAssembly core module or component with the bundled WASM parser. The input is never instantiated or executed.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "WebAssembly module file to inspect." }),
            maxSections: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)).pipe(Schema.optional).annotate({
              description: "Maximum section records. Defaults to 4096.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "wasm_inspect", context, mutation, fs, permission)
              const result = yield* runtime
                .inspect(file.bytes, { maxSections: input.maxSections ?? 4096 })
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
  name: "tool/wasm-inspect",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, WasmInspectRuntime.node],
})
