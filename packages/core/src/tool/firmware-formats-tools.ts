export * as FirmwareFormatsTools from "./firmware-formats-tools"

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
import { FirmwareFormatsRuntime } from "./firmware-formats-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096
const MAX_NODES = 65_536
const MAX_EXPAND_BYTES = 128 * 1024 * 1024
const MAX_DTS_BYTES = 4 * 1024 * 1024

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const maxItems = (description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ITEMS))
    .pipe(Schema.optional)
    .annotate({ description: `${description} Hard maximum ${MAX_ITEMS}.` })

const maxOutputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EXPAND_BYTES))
  .pipe(Schema.optional)
  .annotate({
    description: `Output image cap in bytes, checked before allocation. Hard maximum ${MAX_EXPAND_BYTES}.`,
  })

const flatten = {
  fill: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
    .pipe(Schema.optional)
    .annotate({ description: "Gap-fill byte value (default 255, the erased-flash convention)." }),
  ignoreChecksums: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Skip record checksum enforcement (default false).",
  }),
  maxOutputBytes,
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* FirmwareFormatsRuntime.Service

    const run = Effect.fn("FirmwareFormatsTools.run")(function* (
      request: FirmwareFormatsRuntime.Request,
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

    const report = (file: { readonly resource: string }, result: FirmwareFormatsRuntime.Result, op: string) =>
      Effect.gen(function* () {
        if (result.type !== "report")
          return yield* new ToolFailure({ message: `${op} returned an unexpected byte result` })
        return {
          path: file.resource,
          report: JSON.stringify({ path: file.resource, ...result.report }, null, 2),
        }
      })

    const artifact = Effect.fn("FirmwareFormatsTools.artifact")(function* (
      file: { readonly resource: string },
      result: FirmwareFormatsRuntime.Result,
      op: string,
    ) {
      if (result.type !== "bytes")
        return yield* new ToolFailure({ message: `${op} returned an unexpected report result` })
      return {
        path: file.resource,
        artifactPath: yield* artifacts.writeBytes(result.bytes),
        bytes: result.bytes.length,
        sha256: createHash("sha256").update(result.bytes).digest("hex"),
      }
    })

    yield* tools
      .register({
        android_sparse_parse: Tool.make({
          deferred: true,
          description:
            "Parse one local Android sparse image (magic 0xed26ff3a, v1.x): version, block size, chunk table (raw/fill/dont_care/crc32), expanded byte count, and image CRC32 verification. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Android sparse image to parse."),
            verifyCrc: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Expand in memory and verify a trailing CRC32 chunk when present (default true).",
            }),
            maxChunks: maxItems("Maximum chunk entries returned."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "android_sparse_parse", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "android_sparse_parse",
                  bytes: file.bytes,
                  options: { verifyCrc: input.verifyCrc, maxChunks: input.maxChunks },
                },
                input.path,
              )
              return yield* report(file, result, "android_sparse_parse")
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        android_sparse_expand: Tool.make({
          deferred: true,
          description:
            "Expand one local Android sparse image to its raw output image (raw chunks copied, fill chunks tiled, dont_care zeroed; a trailing CRC32 chunk is verified). The expanded image is written to a retention-managed artifact. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Android sparse image to expand."),
            maxOutputBytes,
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
              text: `Wrote ${output.bytes}-byte expanded image for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "android_sparse_expand", context, mutation, fs, permission)
              const result = yield* run(
                { op: "android_sparse_expand", bytes: file.bytes, options: { maxOutputBytes: input.maxOutputBytes } },
                input.path,
              )
              return yield* artifact(file, result, "android_sparse_expand")
            }).pipe(fail(`Unable to expand ${input.path}`)),
        }),
        dtb_decompile: Tool.make({
          deferred: true,
          description:
            "Decompile one local flattened device tree blob (DTB, magic 0xd00dfeed) to DTS source text: structure-block walk, typed property decoding like dtc, and the memory reserve map. The report carries the dts text and truncation flags. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Flattened device tree blob (.dtb) to decompile."),
            maxOutputBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_DTS_BYTES))
              .pipe(Schema.optional)
              .annotate({ description: `DTS text budget in bytes. Hard maximum ${MAX_DTS_BYTES}.` }),
            maxNodes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NODES))
              .pipe(Schema.optional)
              .annotate({ description: `Maximum nodes walked. Hard maximum ${MAX_NODES}.` }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "dtb_decompile", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "dtb_decompile",
                  bytes: file.bytes,
                  options: { maxOutputBytes: input.maxOutputBytes, maxNodes: input.maxNodes },
                },
                input.path,
              )
              return yield* report(file, result, "dtb_decompile")
            }).pipe(fail(`Unable to decompile ${input.path}`)),
        }),
        ihex_parse: Tool.make({
          deferred: true,
          description:
            "Parse one local Intel HEX file: per-record listing with checksum flags, merged address ranges, gap map, extended base records, EOF and start-address decode, and data vs image byte totals. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Intel HEX (.hex) file to parse."),
            maxRecords: maxItems("Maximum records returned."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "ihex_parse", context, mutation, fs, permission)
              const result = yield* run(
                { op: "ihex_parse", bytes: file.bytes, options: { maxRecords: input.maxRecords } },
                input.path,
              )
              return yield* report(file, result, "ihex_parse")
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        ihex_flatten: Tool.make({
          deferred: true,
          description:
            "Flatten one local Intel HEX file's data records into one contiguous image covering [min_address, max_address]; gaps fill with 0xFF by default and later records win on overlap. Strict checksum enforcement unless ignoreChecksums. The image is written to a retention-managed artifact. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Intel HEX (.hex) file to flatten."),
            ...flatten,
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
              text: `Wrote ${output.bytes}-byte flattened image for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "ihex_flatten", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "ihex_flatten",
                  bytes: file.bytes,
                  options: {
                    fill: input.fill,
                    ignoreChecksums: input.ignoreChecksums,
                    maxOutputBytes: input.maxOutputBytes,
                  },
                },
                input.path,
              )
              return yield* artifact(file, result, "ihex_flatten")
            }).pipe(fail(`Unable to flatten ${input.path}`)),
        }),
        srec_parse: Tool.make({
          deferred: true,
          description:
            "Parse one local Motorola S-Record (SREC/S19) file: per-record listing with checksum flags, S0 header text, S5/S6 count check, start address, merged address ranges, and gap map. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Motorola S-Record (.srec/.s19) file to parse."),
            maxRecords: maxItems("Maximum records returned."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "srec_parse", context, mutation, fs, permission)
              const result = yield* run(
                { op: "srec_parse", bytes: file.bytes, options: { maxRecords: input.maxRecords } },
                input.path,
              )
              return yield* report(file, result, "srec_parse")
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        srec_flatten: Tool.make({
          deferred: true,
          description:
            "Flatten one local Motorola S-Record file's S1/S2/S3 data records into one contiguous image covering [min_address, max_address]; gaps fill with 0xFF by default and later records win on overlap. Strict checksum enforcement unless ignoreChecksums. The image is written to a retention-managed artifact. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("Motorola S-Record (.srec/.s19) file to flatten."),
            ...flatten,
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
              text: `Wrote ${output.bytes}-byte flattened image for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "srec_flatten", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "srec_flatten",
                  bytes: file.bytes,
                  options: {
                    fill: input.fill,
                    ignoreChecksums: input.ignoreChecksums,
                    maxOutputBytes: input.maxOutputBytes,
                  },
                },
                input.path,
              )
              return yield* artifact(file, result, "srec_flatten")
            }).pipe(fail(`Unable to flatten ${input.path}`)),
        }),
        uboot_env_parse: Tool.make({
          deferred: true,
          description:
            "Parse one local U-Boot environment blob: stored CRC32 (matched against both byte orders), redundancy layout (plain or redundant flag byte), and NUL-separated key=value entries with termination and truncation flags. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("U-Boot environment blob to parse."),
            redundant: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Force the redundant layout (flag byte at offset 4); omit to auto-detect from the CRC.",
            }),
            maxEntries: maxItems("Maximum entries returned."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "uboot_env_parse", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "uboot_env_parse",
                  bytes: file.bytes,
                  options: { redundant: input.redundant, maxEntries: input.maxEntries },
                },
                input.path,
              )
              return yield* report(file, result, "uboot_env_parse")
            }).pipe(fail(`Unable to parse ${input.path}`)),
        }),
        uimage_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one local legacy U-Boot uImage 64-byte header (magic 0x27051956): name, timestamp, load/entry addresses, data size, decoded os/arch/type/compression enums, and header + data CRC32 verification. Bounded, offline.",
          input: Schema.Struct({
            path: FilePath("U-Boot uImage file to inspect."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "uimage_inspect", context, mutation, fs, permission)
              const result = yield* run({ op: "uimage_inspect", bytes: file.bytes, options: {} }, input.path)
              return yield* report(file, result, "uimage_inspect")
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/firmware-formats",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    FirmwareFormatsRuntime.node,
  ],
})
