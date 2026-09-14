export * as BrowserArtifactsTools from "./browser-artifacts-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { BrowserArtifactsRuntime } from "./browser-artifacts-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 4096

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const maxResults = boundedInt(
  MAX_RESULTS,
  `Maximum records returned. Defaults to 256; hard maximum ${MAX_RESULTS}.`,
)

const verifyCrc = Schema.Boolean.pipe(Schema.optional).annotate({
  description: "Verify record/block CRC checksums. Defaults to true.",
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* BrowserArtifactsRuntime.Service

    const run = Effect.fn("BrowserArtifactsTools.run")(function* (
      request: BrowserArtifactsRuntime.Request,
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
        leveldb_log_parse: Tool.make({
          deferred: true,
          description:
            "Parse one Chromium LevelDB write log (.log, the journal behind Local Storage, Session Storage, and IndexedDB): CRC-32C-verified physical records reassembled into WriteBatches, then decoded to per-entry rows with operation (put/delete — deleted-record recovery is the forensic point), key, and value previews. Corrupt records are flagged and resynced, never fatal. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "LevelDB .log write-log file to parse." }),
            maxResults,
            verifyCrc,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "leveldb_log_parse", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "leveldb_log_parse",
                  bytes: file.bytes,
                  options: { max_results: input.maxResults, verify_crc: input.verifyCrc },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        leveldb_table_parse: Tool.make({
          deferred: true,
          description:
            "Parse one Chromium LevelDB table (.ldb/.sst): the 48-byte footer, metaindex and index blocks, then every referenced data block decoded with shared-prefix restart-array decompression. Snappy blocks decompress under a 64 MiB cap; CRC-32C verifies per block. Internal keys decode to sequence, operation (tombstones surface as delete), user_key, and value. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "LevelDB .ldb/.sst table file to parse." }),
            maxResults,
            verifyCrc,
            includeIndex: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Also list index-block entries. Defaults to false.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "leveldb_table_parse", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "leveldb_table_parse",
                  bytes: file.bytes,
                  options: {
                    max_results: input.maxResults,
                    verify_crc: input.verifyCrc,
                    include_index: input.includeIndex,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        chrome_cache_parse: Tool.make({
          deferred: true,
          description:
            "Parse one Chromium simple-disk-cache entry file: SimpleFileHeader, the stored key (usually a URL) verified against its SuperFastHash and optional key SHA-256, stream layout resolution, per-stream CRC-32 checks, sparse-range identification, and a best-effort HttpResponseInfo decode of stream 0 yielding response times and raw headers. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Chromium simple-cache entry file to parse." }),
            maxResults,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "chrome_cache_parse", context, mutation, fs, permission)
              const report = yield* run(
                { op: "chrome_cache_parse", bytes: file.bytes, options: { max_results: input.maxResults } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        safari_cookies_parse: Tool.make({
          deferred: true,
          description:
            "Parse one Safari Cookies.binarycookies jar: cook magic, page table, and cookie records decoded to domain, path, name, secure/http_only flags, Unix timestamps, and bounded value previews. The trailing checksum, footer magic, and optional bplist metadata are reported. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Safari Cookies.binarycookies file to parse." }),
            maxResults,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "safari_cookies_parse", context, mutation, fs, permission)
              const report = yield* run(
                { op: "safari_cookies_parse", bytes: file.bytes, options: { max_results: input.maxResults } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        browser_analyze: Tool.make({
          deferred: true,
          description:
            "Auto-detect one browser forensic artifact file (Safari binarycookies, Chromium simple-cache entry or sparse file, LevelDB sstable, or LevelDB write log) and run the matching bounded parser. Unrecognized input reports an unknown_artifact error. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Browser artifact file to identify and parse." }),
            maxResults,
            verifyCrc,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "browser_analyze", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "analyze",
                  bytes: file.bytes,
                  options: { max_results: input.maxResults, verify_crc: input.verifyCrc },
                },
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
  name: "tool/browser-artifacts",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, BrowserArtifactsRuntime.node],
})
