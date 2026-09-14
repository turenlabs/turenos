export * as MacosArtifactsTools from "./macos-artifacts-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { MacosArtifactsRuntime } from "./macos-artifacts-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 4096
const MAX_PLIST_DEPTH = 32
const MAX_PLIST_ITEMS = 4096
const MAX_STRING_CHARS = 1024

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const maxResults = boundedInt(
  MAX_RESULTS,
  `Maximum records returned. Defaults to 256; hard maximum ${MAX_RESULTS}.`,
)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* MacosArtifactsRuntime.Service

    const run = Effect.fn("MacosArtifactsTools.run")(function* (
      request: MacosArtifactsRuntime.Request,
      path: string,
    ) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message }),
      )

    yield* tools
      .register({
        plist_parse: Tool.make({
          deferred: true,
          description:
            "Parse one Apple property list file (binary bplist00 or XML) into bounded JSON: the full structure with typed node counts and maximum observed depth; data values render as length, SHA-256, and preview. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Property list file to parse." }),
            maxDepth: boundedInt(
              MAX_PLIST_DEPTH,
              `Maximum nesting depth decoded. Defaults to ${MAX_PLIST_DEPTH}; hard maximum ${MAX_PLIST_DEPTH}.`,
            ),
            maxItems: boundedInt(
              MAX_PLIST_ITEMS,
              `Maximum items decoded per container. Defaults to ${MAX_PLIST_ITEMS}; hard maximum ${MAX_PLIST_ITEMS}.`,
            ),
            maxStringChars: boundedInt(
              MAX_STRING_CHARS,
              `Maximum characters kept per string value. Defaults to ${MAX_STRING_CHARS}; hard maximum ${MAX_STRING_CHARS}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "plist_parse", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "plist_parse",
                  bytes: file.bytes,
                  options: {
                    max_depth: input.maxDepth,
                    max_items: input.maxItems,
                    max_string_chars: input.maxStringChars,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        fsevents_parse: Tool.make({
          deferred: true,
          description:
            "Parse one macOS .fseventsd disk-log file (gzip-wrapped or raw 1SLD/2SLD/3SLD record pages) into bounded JSON records: event_id, path, decoded flag names, and node_id. A corrupt tail truncates with a warning instead of failing. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "FSEvents disk-log file to parse." }),
            maxResults,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "fsevents_parse", context, mutation, fs, permission)
              const report = yield* run(
                { op: "fsevents_parse", bytes: file.bytes, options: { max_results: input.maxResults } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        unified_log_parse: Tool.make({
          deferred: true,
          description:
            "Parse one macOS .tracev3 unified-log file into bounded JSON: header metadata (timebase, boot UUID, build, hardware model, timezone), catalog statistics, and reconstructed log entries (timestamp, process, subsystem, category, level, message). uuidtext/dsc tables are unavailable, so unresolved format strings surface as explicit markers plus counted warnings. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Unified-log .tracev3 file to parse." }),
            maxResults,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "unified_log_parse", context, mutation, fs, permission)
              const report = yield* run(
                { op: "unified_log_parse", bytes: file.bytes, options: { max_results: input.maxResults } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        ds_store_parse: Tool.make({
          deferred: true,
          description:
            "Parse one macOS .DS_Store file: buddy-allocator header and TOC, the DSDB superblock, then a depth-limited B-tree walk yielding filename/code/type/value records. Iloc blobs decode to x/y; plist blobs decode inline; other blobs report length, SHA-256, and preview. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: ".DS_Store file to parse." }),
            maxResults,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "ds_store_parse", context, mutation, fs, permission)
              const report = yield* run(
                { op: "ds_store_parse", bytes: file.bytes, options: { max_results: input.maxResults } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        macos_analyze: Tool.make({
          deferred: true,
          description:
            "Auto-detect one macOS forensic artifact file (binary/XML plist, gzip-wrapped or raw FSEvents disk log, .DS_Store, or .tracev3 unified log) and run the matching bounded parser. Unrecognized input reports an unknown_artifact error. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "macOS artifact file to identify and parse." }),
            maxResults,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "macos_analyze", context, mutation, fs, permission)
              const report = yield* run(
                { op: "analyze", bytes: file.bytes, options: { max_results: input.maxResults } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to analyze ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/macos-artifacts",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, MacosArtifactsRuntime.node],
})
