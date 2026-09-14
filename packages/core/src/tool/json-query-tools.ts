export * as JsonQueryTools from "./json-query-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { JsonQueryRuntime } from "./json-query-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_LIMIT = 4096
const MAX_FILTER_CHARS = 4096

const limit = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LIMIT))
  .pipe(Schema.optional)
  .annotate({
    description: `Maximum results returned. Defaults to ${MAX_LIMIT}; hard maximum ${MAX_LIMIT}. Serialized output is capped at 4 MiB.`,
  })

const FilePath = Schema.NonEmptyString.annotate({ description: "Local JSON or NDJSON file to interrogate." })
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* JsonQueryRuntime.Service

    const run = Effect.fn("JsonQueryTools.run")(function* (request: JsonQueryRuntime.Request, path: string) {
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

    const report = Effect.fn("JsonQueryTools.report")(function* (
      op: JsonQueryRuntime.Request["op"],
      options: Readonly<Record<string, unknown>> | undefined,
      path: string,
      context: Tool.Context,
    ) {
      const file = yield* read(path, op, context, mutation, fs, permission)
      const request: JsonQueryRuntime.Request =
        op === "json_query" || op === "json_paths"
          ? { op, bytes: file.bytes, options: options ?? {} }
          : { op, bytes: file.bytes }
      const result = yield* run(request, path)
      return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
    })

    yield* tools
      .register({
        json_query: Tool.make({
          deferred: true,
          description:
            "Evaluate a bounded jq-style filter over a local JSON or NDJSON file with the pure-Rust jaq engine in WebAssembly — no jq process is spawned. Results are capped per call and the serialized report is capped at 4 MiB; evaluation is wall-clock bounded by the worker.",
          input: Schema.Struct({
            path: FilePath,
            filter: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_FILTER_CHARS)).annotate({
              description: `jq/jaq filter evaluated against each input JSON value. Hard maximum ${MAX_FILTER_CHARS} characters; env, import, and halt-style filters resolve to errors.`,
            }),
            slurp: Schema.Boolean.pipe(Schema.optional).annotate({
              description:
                "Collect all input values into one array and run the filter once (jq -s). Defaults to false.",
            }),
            nullInput: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Run the filter once on null without reading the input bytes (jq -n). Defaults to false.",
            }),
            limit,
            rawOutput: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Render each result as jq -r text (strings unwrapped). Defaults to false.",
            }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "json_query",
              {
                filter: input.filter,
                slurp: input.slurp,
                nullInput: input.nullInput,
                limit: input.limit,
                rawOutput: input.rawOutput,
              },
              input.path,
              context,
            ).pipe(fail(`Unable to query ${input.path}`)),
        }),
        json_validate: Tool.make({
          deferred: true,
          description:
            "Strictly validate a local file as RFC 8259 JSON and report token statistics (bytes, depth, object/array/scalar counts) plus the line and column of the first parse error. Bounded and offline; the document is never evaluated.",
          input: Schema.Struct({ path: FilePath }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("json_validate", undefined, input.path, context).pipe(fail(`Unable to validate ${input.path}`)),
        }),
        json_stats: Tool.make({
          deferred: true,
          description:
            "Summarize the top-level shape of a local JSON file — type, length, keys, per-key types, and a value-type histogram — for fast orientation before deeper analysis. Bounded and offline.",
          input: Schema.Struct({ path: FilePath }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("json_stats", undefined, input.path, context).pipe(fail(`Unable to summarize ${input.path}`)),
        }),
        json_paths: Tool.make({
          deferred: true,
          description:
            "Enumerate leaf paths (scalars and empty containers) in a local JSON file using jq path notation with type tags. Useful for locating interesting fields inside large opaque documents; bounded and offline.",
          input: Schema.Struct({
            path: FilePath,
            limit: limit.annotate({
              description: `Maximum paths returned. Defaults to ${MAX_LIMIT}; hard maximum ${MAX_LIMIT}.`,
            }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("json_paths", { limit: input.limit }, input.path, context).pipe(
              fail(`Unable to enumerate paths in ${input.path}`),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/json-query",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, JsonQueryRuntime.node],
})
