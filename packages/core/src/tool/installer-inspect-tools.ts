export * as InstallerInspectTools from "./installer-inspect-tools"

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
import { InstallerInspectRuntime } from "./installer-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096
const MAX_NAME = 1024
// Serialized contentBase64 payloads must fit the module's ~3 MiB JSON budget.
const MAX_EXTRACT_BYTES = 3 * 1024 * 1024

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const maxItems = (description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ITEMS))
    .pipe(Schema.optional)
    .annotate({ description: `${description} Hard maximum ${MAX_ITEMS}.` })

const maxBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EXTRACT_BYTES))
  .pipe(Schema.optional)
  .annotate({
    description: `Preview cap: return at most this many leading bytes. Hard maximum ${MAX_EXTRACT_BYTES}.`,
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* InstallerInspectRuntime.Service

    const run = Effect.fn("InstallerInspectTools.run")(function* (
      request: InstallerInspectRuntime.Request,
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
        msi_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one local Windows Installer (MSI) / OLE compound file: container listing, decoded database tables, embedded stream metadata, CustomAction type decoding, sequence ordering, and triage findings (custom-action payloads, suspicious targets, service installs, registry persistence). Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("MSI or OLE/CFB compound file to inspect."),
            maxRowsPerTable: maxItems("Maximum decoded rows per table."),
            maxTables: maxItems("Maximum tables decoded."),
            tableFilter: Schema.NonEmptyString.check(Schema.isMaxLength(256))
              .pipe(Schema.optional)
              .annotate({ description: "Decode only the named table, for example CustomAction." }),
            includeStreamHashes: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Hash embedded stream contents (default true).",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "msi_inspect", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "msi_inspect",
                  bytes: file.bytes,
                  options: {
                    maxRowsPerTable: input.maxRowsPerTable,
                    maxTables: input.maxTables,
                    tableFilter: input.tableFilter,
                    includeStreamHashes: input.includeStreamHashes,
                  },
                },
                input.path,
              )
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "msi_inspect returned an unexpected byte result" })
              return {
                path: file.resource,
                report: JSON.stringify({ path: file.resource, ...result.report }, null, 2),
              }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        msi_stream_read: Tool.make({
          deferred: true,
          description:
            "Read exactly one embedded stream from a local MSI / OLE compound file by decoded stream name (from msi_inspect streams[].name) or raw CFB path. The stream bytes are written to a retention-managed artifact. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("MSI or OLE/CFB compound file to read from."),
            stream: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_NAME)).annotate({
              description: "Decoded stream name (for example evil.dll) or raw CFB path.",
            }),
            maxBytes,
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
              text: `Wrote ${output.bytes}-byte stream for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "msi_stream_read", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "msi_stream_read",
                  bytes: file.bytes,
                  options: { stream: input.stream, maxBytes: input.maxBytes },
                },
                input.path,
              )
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "msi_stream_read returned an unexpected report result" })
              return {
                path: `${file.resource}:${typeof result.report.stream === "string" ? result.report.stream : input.stream}`,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to read stream ${input.stream} from ${input.path}`)),
        }),
        cab_list: Tool.make({
          deferred: true,
          description:
            "List the contents of one local Microsoft Cabinet (.cab) file: header fields, folders with compression schemes, and file entries with sizes, folder offsets, DOS timestamps, attributes, and cabinet-spanning markers. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Microsoft Cabinet (.cab) file to list."),
            maxFiles: maxItems("Maximum file entries returned."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "cab_list", context, mutation, fs, permission)
              const result = yield* run(
                { op: "cab_list", bytes: file.bytes, options: { maxFiles: input.maxFiles } },
                input.path,
              )
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "cab_list returned an unexpected byte result" })
              return {
                path: file.resource,
                report: JSON.stringify({ path: file.resource, ...result.report }, null, 2),
              }
            }).pipe(fail(`Unable to list ${input.path}`)),
        }),
        cab_extract: Tool.make({
          deferred: true,
          description:
            "Decompress exactly one named member of a local Microsoft Cabinet (.cab) file (none/mszip/lzx compression). The member bytes are written to a retention-managed artifact; member names are never interpreted as host paths. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Microsoft Cabinet (.cab) file to extract from."),
            member: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_NAME)).annotate({
              description: "Exact member name from cab_list, for example readme.txt.",
            }),
            maxBytes,
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
              text: `Wrote ${output.bytes}-byte cabinet member for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "cab_extract", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "cab_extract",
                  bytes: file.bytes,
                  options: { file: input.member, maxBytes: input.maxBytes },
                },
                input.path,
              )
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "cab_extract returned an unexpected report result" })
              return {
                path: `${file.resource}:${typeof result.report.file === "string" ? result.report.file : input.member}`,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to extract ${input.member} from ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/installer-inspect",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    InstallerInspectRuntime.node,
  ],
})
