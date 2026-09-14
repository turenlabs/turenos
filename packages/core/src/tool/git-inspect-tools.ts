export * as GitInspectTools from "./git-inspect-tools"

import { createHash } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { ToolOutputStore } from "../tool-output-store"
import { read } from "./binary-file"
import { GitInspectRuntime } from "./git-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096
const MAX_PREVIEW_BYTES = 64 * 1024
const MAX_ENTRIES_SCANNED = 65_536
const MAX_OFFSET = 32 * 1024 * 1024

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const maxItems = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ITEMS))
  .pipe(Schema.optional)
  .annotate({ description: `Maximum reported entries returned. Hard maximum ${MAX_ITEMS}.` })

const maxPreviewBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_PREVIEW_BYTES))
  .pipe(Schema.optional)
  .annotate({ description: `Base64 content preview cap in bytes. Hard maximum ${MAX_PREVIEW_BYTES}.` })

const selector = {
  index: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_ENTRIES_SCANNED))
    .pipe(Schema.optional)
    .annotate({ description: "Entry index into the pack (0-based). Exactly one of index or offset is required." }),
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_OFFSET))
    .pipe(Schema.optional)
    .annotate({
      description: "Byte offset of the entry inside the pack, from git_pack_inspect. Exactly one of index or offset is required.",
    }),
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* GitInspectRuntime.Service

    const run = Effect.fn("GitInspectTools.run")(function* (request: GitInspectRuntime.Request, path: string) {
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

    const report = (file: { readonly resource: string }, result: GitInspectRuntime.Result, op: string) =>
      Effect.gen(function* () {
        if (result.type !== "report")
          return yield* new ToolFailure({ message: `${op} returned an unexpected byte result` })
        return {
          path: file.resource,
          report: JSON.stringify({ path: file.resource, ...result.report }, null, 2),
        }
      })

    const selectorOptions = (input: { readonly index?: number; readonly offset?: number }, op: string) =>
      Effect.gen(function* () {
        if (input.index === undefined && input.offset === undefined)
          return yield* new ToolFailure({ message: `${op} requires exactly one of index or offset` })
        if (input.index !== undefined && input.offset !== undefined)
          return yield* new ToolFailure({ message: `${op} accepts only one of index or offset` })
        return { index: input.index, offset: input.offset }
      })

    yield* tools
      .register({
        git_identify: Tool.make({
          deferred: true,
          description:
            "Classify one local git storage file's bytes without a repository or git binary: loose object, packfile, pack index (v1/v2), DIRC index, or bundle, with version/counts/checksum facts. Bounded, offline, read-only.",
          input: Schema.Struct({
            path: FilePath("Git storage file to classify (loose object, pack, .idx, index, or bundle)."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "git_identify", context, mutation, fs, permission)
              const result = yield* run({ op: "git_identify", bytes: file.bytes, options: {} }, input.path)
              return yield* report(file, result, "git_identify")
            }).pipe(fail(`Unable to identify ${input.path}`)),
        }),
        git_object_decode: Tool.make({
          deferred: true,
          description:
            "Inflate and decode one local git loose object file (zlib 'type SP size NUL content'): recomputed SHA-1, declared-size check, commit/tag/tree structured fields, and a bounded base64 preview plus SHA-256 for blobs. Bounded, offline, read-only.",
          input: Schema.Struct({
            path: FilePath("Loose git object file to inflate and decode."),
            maxPreviewBytes,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "git_object_decode", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "git_object_decode",
                  bytes: file.bytes,
                  options: { maxPreviewBytes: input.maxPreviewBytes },
                },
                input.path,
              )
              return yield* report(file, result, "git_object_decode")
            }).pipe(fail(`Unable to decode ${input.path}`)),
        }),
        git_pack_inspect: Tool.make({
          deferred: true,
          description:
            "Summarize one local git packfile: version, declared vs parsed object count, per-entry type/offset/size list, ofs-delta and ref-delta counts with max chain depth, and trailing SHA-1 verification. Bounded, offline, read-only.",
          input: Schema.Struct({
            path: FilePath("Git packfile (.pack) to inspect."),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "git_pack_inspect", context, mutation, fs, permission)
              const result = yield* run(
                { op: "git_pack_inspect", bytes: file.bytes, options: { maxItems: input.maxItems } },
                input.path,
              )
              return yield* report(file, result, "git_pack_inspect")
            }).pipe(fail(`Unable to inspect pack ${input.path}`)),
        }),
        git_pack_entry: Tool.make({
          deferred: true,
          description:
            "Resolve one entry of a local git packfile selected by index or offset, following ofs-delta/ref-delta chains: resolved type, size, SHA-1, SHA-256, chain depth, and a bounded base64 content preview. For full object bytes use git_pack_entry_raw. Bounded, offline, read-only.",
          input: Schema.Struct({
            path: FilePath("Git packfile (.pack) to read from."),
            ...selector,
            maxPreviewBytes,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "git_pack_entry", context, mutation, fs, permission)
              const selected = yield* selectorOptions(input, "git_pack_entry")
              const result = yield* run(
                {
                  op: "git_pack_entry",
                  bytes: file.bytes,
                  options: { ...selected, maxPreviewBytes: input.maxPreviewBytes },
                },
                input.path,
              )
              return yield* report(file, result, "git_pack_entry")
            }).pipe(fail(`Unable to resolve pack entry in ${input.path}`)),
        }),
        git_pack_entry_raw: Tool.make({
          deferred: true,
          description:
            "Resolve one entry of a local git packfile selected by index or offset and return the complete inflated object bytes (delta chains followed), written to a retention-managed artifact. Bounded, offline, read-only.",
          input: Schema.Struct({
            path: FilePath("Git packfile (.pack) to read from."),
            ...selector,
          }),
          output: Schema.Struct({
            path: Schema.String,
            artifactPath: Schema.String,
            bytes: Schema.Int,
            sha256: Schema.String,
          }),
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte pack entry for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "git_pack_entry_raw", context, mutation, fs, permission)
              const selected = yield* selectorOptions(input, "git_pack_entry_raw")
              const result = yield* run(
                { op: "git_pack_entry_raw", bytes: file.bytes, options: selected },
                input.path,
              )
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "git_pack_entry_raw returned an unexpected report result" })
              return {
                path: `${file.resource}#${input.index !== undefined ? `index ${input.index}` : `offset ${input.offset}`}`,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to resolve pack entry in ${input.path}`)),
        }),
        git_index_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one local git DIRC index file (v2/v3/v4): version, declared vs parsed entry counts, entries with path/SHA-1/mode/stage/stat fields, extension names and sizes, and trailer checksum verification. Bounded, offline, read-only.",
          input: Schema.Struct({
            path: FilePath("Git index (DIRC) file to inspect."),
            maxItems,
            includeExtensions: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Include the extension table (default true).",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "git_index_inspect", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "git_index_inspect",
                  bytes: file.bytes,
                  options: { maxItems: input.maxItems, includeExtensions: input.includeExtensions },
                },
                input.path,
              )
              return yield* report(file, result, "git_index_inspect")
            }).pipe(fail(`Unable to inspect index ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/git-inspect",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    GitInspectRuntime.node,
  ],
})
