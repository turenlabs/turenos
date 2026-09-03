export * as BinwalkScanTools from "./binwalk-scan-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { BinwalkScanRuntime } from "./binwalk-scan-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_FINDINGS = 4096
const DEFAULT_FINDINGS = 256

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* BinwalkScanRuntime.Service
    yield* tools
      .register({
        binwalk_scan: Tool.make({
          description:
            "Perform a bounded, scan-only signature search over one local binary file. It does not extract, decompress, or execute the input or any embedded content.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "File to scan for embedded signatures." }),
            maxFindings: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_FINDINGS)).pipe(Schema.optional).annotate({
              description: `Maximum findings returned. Defaults to ${DEFAULT_FINDINGS}; hard maximum ${MAX_FINDINGS}.`,
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "binwalk_scan", context, mutation, fs, permission)
              const result = yield* runtime
                .scan(file.bytes, { maxFindings: input.maxFindings ?? DEFAULT_FINDINGS })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to scan ${input.path}: ${error.message}` })))
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to scan ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/binwalk-scan",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, BinwalkScanRuntime.node],
})
