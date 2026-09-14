export * as CryptoMarkersTools from "./crypto-markers-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { CryptoMarkersRuntime } from "./crypto-markers-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_FINDINGS = 4096
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const MAX_TOP_K = 64
const MAX_KEY_LENGTH = 8
const MAX_KEYS = 64
const MAX_CRIB_BYTES = 64
const MAX_FILTER_ITEMS = 64

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* CryptoMarkersRuntime.Service

    const run = Effect.fn("CryptoMarkersTools.run")(function* (
      request: CryptoMarkersRuntime.Request,
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
        byte_stats: Tool.make({
          deferred: true,
          description:
            "Profile one local file's byte structure: length, Shannon entropy, histogram top bytes, null/printable/high ratios, line endings, longest run, and ASCII/UTF-16LE string counts. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("File to profile."),
            minStringLength: boundedInt(64, "Minimum run length counted as a string. Defaults to 4; range 1-64."),
            topBytes: boundedInt(64, "Histogram entries returned. Defaults to 16; range 1-64."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "byte_stats", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "byte_stats",
                  bytes: file.bytes,
                  options: { minStringLength: input.minStringLength, topBytes: input.topBytes },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to profile ${input.path}`)),
        }),
        crypto_constants: Tool.make({
          deferred: true,
          description:
            "Scan one local file for known cryptographic constants, algorithm-identifier OIDs, key-structure templates, and keying-material strings (AES/SHA/MD5/ChaCha/DES tables, DER OIDs, PEM/JWT/bcrypt shapes). Bounded to 4096 findings, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("File to scan for cryptographic constants."),
            maxFindings: boundedInt(
              MAX_FINDINGS,
              `Maximum findings returned. Defaults to ${MAX_FINDINGS}; hard maximum ${MAX_FINDINGS}.`,
            ),
            minConfidence: Schema.Literals(["low", "medium", "high"])
              .pipe(Schema.optional)
              .annotate({ description: 'Minimum confidence reported. Defaults to "low".' }),
            algorithms: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(128)))
              .check(Schema.isMaxLength(MAX_FILTER_ITEMS))
              .pipe(Schema.optional)
              .annotate({
                description: `Optional algorithm-name filter (for example ["aes","sha256"]). At most ${MAX_FILTER_ITEMS} entries.`,
              }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "crypto_constants", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "crypto_constants",
                  bytes: file.bytes,
                  options: {
                    maxFindings: input.maxFindings,
                    minConfidence: input.minConfidence,
                    algorithms: input.algorithms,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to scan ${input.path}`)),
        }),
        entropy_map: Tool.make({
          deferred: true,
          description:
            "Map sliding-window Shannon entropy over one local file with byte-class summaries and classification hints (packed/encrypted vs code vs padding). Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("File to map entropy over."),
            windowSize: PositiveInt.check(
              Schema.isGreaterThanOrEqualTo(16),
              Schema.isLessThanOrEqualTo(MAX_SCAN_BYTES),
            )
              .pipe(Schema.optional)
              .annotate({
                description: `Sliding window size in bytes. Defaults to 4096; range 16-${MAX_SCAN_BYTES}.`,
              }),
            stride: boundedInt(
              MAX_SCAN_BYTES,
              `Stride between windows in bytes. Defaults to the window size; range 1-${MAX_SCAN_BYTES}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "entropy_map", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "entropy_map",
                  bytes: file.bytes,
                  options: { windowSize: input.windowSize, stride: input.stride },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to map entropy of ${input.path}`)),
        }),
        xor_probe: Tool.make({
          deferred: true,
          description:
            "Score single-byte XOR keys 0x00-0xFF and short multi-byte keys against one local file using printable-ASCII ratio plus magic/content hits; a known-plaintext crib derives the exact repeating key. Bounded scan, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("File to probe for XOR-obfuscated content."),
            topK: boundedInt(MAX_TOP_K, `Candidate keys returned. Defaults to 8; hard maximum ${MAX_TOP_K}.`),
            scanBytes: boundedInt(
              MAX_SCAN_BYTES,
              `Bytes scored, from the start of the file. Defaults to 256 KiB; hard maximum ${MAX_SCAN_BYTES}.`,
            ),
            maxKeyLength: boundedInt(
              MAX_KEY_LENGTH,
              `Longest multi-byte key length attempted. Defaults to 1 (single-byte exhaustive); hard maximum ${MAX_KEY_LENGTH}.`,
            ),
            keys: Schema.Array(Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{2,64}$/)))
              .check(Schema.isMaxLength(MAX_KEYS))
              .pipe(Schema.optional)
              .annotate({ description: `Extra hex-encoded candidate keys, 1-32 bytes each, at most ${MAX_KEYS}.` }),
            crib: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_CRIB_BYTES))
              .pipe(Schema.optional)
              .annotate({
                description: `Known plaintext expected at offset 0, for example MZ or a file magic. At most ${MAX_CRIB_BYTES} characters.`,
              }),
            cribHex: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{2,128}$/))
              .pipe(Schema.optional)
              .annotate({ description: `Hex-encoded known plaintext. At most ${MAX_CRIB_BYTES} bytes.` }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "xor_probe", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "xor_probe",
                  bytes: file.bytes,
                  options: {
                    topK: input.topK,
                    scanBytes: input.scanBytes,
                    maxKeyLength: input.maxKeyLength,
                    keys: input.keys,
                    crib: input.crib,
                    cribHex: input.cribHex,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to probe ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/crypto-markers",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, CryptoMarkersRuntime.node],
})
