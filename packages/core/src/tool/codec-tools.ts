export * as CodecTools from "./codec-tools"

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
import { CodecRuntime } from "./codec-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
const MAX_HINT_BYTES = 4 * 1024 * 1024

const maxOutputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES))
  .pipe(Schema.optional)
  .annotate({
    description: `Maximum transform output in bytes; output that exceeds the cap fails instead of truncating. Hard maximum ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB.`,
  })

const level = NonNegativeInt.check(Schema.isLessThanOrEqualTo(11)).pipe(Schema.optional).annotate({
  description: "Compression level: deflate 0-9 (default 6), brotli 0-11 (default 5); ignored for other algorithms.",
})

const expectedOutputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_HINT_BYTES))
  .pipe(Schema.optional)
  .annotate({
    description: `Expected decompressed size, used only as a pre-allocation hint. Hard maximum ${MAX_HINT_BYTES / 1024 / 1024} MiB.`,
  })

const CompressAlgorithm = Schema.Literals([
  "gzip",
  "gz",
  "zlib",
  "deflate",
  "brotli",
  "br",
  "lz4",
  "lz4-block",
  "xz",
  "lzma",
  "lzma-alone",
  "lzma2",
]).annotate({ description: "Compression algorithm. bzip2 and zstd are decode-only and unsupported here." })

const DecompressAlgorithm = Schema.Literals([
  "gzip",
  "gz",
  "zlib",
  "deflate",
  "brotli",
  "br",
  "lz4",
  "lz4-block",
  "bzip2",
  "bz2",
  "xz",
  "lzma",
  "lzma-alone",
  "lzma2",
  "zstd",
  "zst",
]).annotate({ description: "Decompression algorithm." })

const TextEncoding = Schema.Literals([
  "hex",
  "base64",
  "base64url",
  "base32",
  "base32hex",
  "base58",
  "base58check",
  "z85",
  "base85",
  "quoted-printable",
  "qp",
  "uuencode",
  "uudecode",
  "uu",
]).annotate({ description: "Text encoding." })

const FilePath = Schema.NonEmptyString.annotate({ description: "Local file to transform." })
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })
const BytesOutput = Schema.Struct({
  path: Schema.String,
  artifactPath: Schema.String,
  bytes: Schema.Int,
  sha256: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* CodecRuntime.Service

    const run = Effect.fn("CodecTools.run")(function* (request: CodecRuntime.Request, path: string) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run codec_${request.op} on ${path}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) => (error instanceof ToolFailure ? error : new ToolFailure({ message })))

    const transform = Effect.fn("CodecTools.transform")(function* (
      op: "compress" | "decompress" | "encode" | "decode",
      path: string,
      format: string,
      options: Readonly<Record<string, unknown>>,
      context: Tool.Context,
    ) {
      const file = yield* read(path, `codec_${op}`, context, mutation, fs, permission)
      const result = yield* run({ op, format, bytes: file.bytes, options }, path)
      if (result.type !== "bytes")
        return yield* new ToolFailure({ message: `codec_${op} returned an unexpected report result` })
      return {
        path: file.resource,
        artifactPath: yield* artifacts.writeBytes(result.bytes),
        bytes: result.bytes.length,
        sha256: createHash("sha256").update(result.bytes).digest("hex"),
      }
    })

    yield* tools
      .register({
        codec_compress: Tool.make({
          deferred: true,
          description:
            "Compress a local file with gzip, zlib, deflate, brotli, lz4, lz4-block, xz, lzma, or lzma2 using a bounded pure-Rust WebAssembly codec. Deterministic and offline; the compressed output is written to a retention-managed artifact.",
          input: Schema.Struct({
            path: FilePath,
            algorithm: CompressAlgorithm,
            level,
            maxOutputBytes,
          }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte compressed output for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            transform(
              "compress",
              input.path,
              input.algorithm,
              {
                level: input.level,
                maxOutputBytes: input.maxOutputBytes,
              },
              context,
            ).pipe(fail(`Unable to compress ${input.path}`)),
        }),
        codec_decompress: Tool.make({
          deferred: true,
          description:
            "Decompress a local gzip, zlib, deflate, brotli, lz4, lz4-block, bzip2, xz, lzma, lzma2, or zstd file with a bounded WebAssembly codec. Output streams through a hard byte cap so decompression bombs fail instead of expanding; the result is written to a retention-managed artifact.",
          input: Schema.Struct({
            path: FilePath,
            algorithm: DecompressAlgorithm,
            maxOutputBytes,
            expectedOutputBytes,
          }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte decompressed output for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            transform(
              "decompress",
              input.path,
              input.algorithm,
              {
                maxOutputBytes: input.maxOutputBytes,
                expectedOutputBytes: input.expectedOutputBytes,
              },
              context,
            ).pipe(fail(`Unable to decompress ${input.path}`)),
        }),
        codec_encode: Tool.make({
          deferred: true,
          description:
            "Encode a local file to a text encoding — hex, base64, base64url, base32, base32hex, base58, base58check, z85, quoted-printable, or uuencode — with a bounded WebAssembly codec. The encoded output is written to a retention-managed artifact.",
          input: Schema.Struct({
            path: FilePath,
            encoding: TextEncoding,
            maxOutputBytes,
          }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte encoded output for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            transform(
              "encode",
              input.path,
              input.encoding,
              {
                maxOutputBytes: input.maxOutputBytes,
              },
              context,
            ).pipe(fail(`Unable to encode ${input.path}`)),
        }),
        codec_decode: Tool.make({
          deferred: true,
          description:
            "Decode a hex, base64, base32, base58, z85, quoted-printable, or uuencode text file back to raw bytes with a bounded WebAssembly codec. Useful for recovering payloads from encoded evidence; the decoded output is written to a retention-managed artifact.",
          input: Schema.Struct({
            path: FilePath,
            encoding: TextEncoding,
            maxOutputBytes,
          }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte decoded output for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            transform(
              "decode",
              input.path,
              input.encoding,
              {
                maxOutputBytes: input.maxOutputBytes,
              },
              context,
            ).pipe(fail(`Unable to decode ${input.path}`)),
        }),
        codec_detect: Tool.make({
          deferred: true,
          description:
            "Identify the likely compression format or text encoding of a local file using magic-byte matching and charset sniffing. Read-only and bounded — nothing is decoded, decompressed, or executed.",
          input: Schema.Struct({ path: FilePath }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "codec_detect", context, mutation, fs, permission)
              const result = yield* run({ op: "detect", bytes: file.bytes }, input.path)
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "codec_detect returned an unexpected byte result" })
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result.report }, null, 2) }
            }).pipe(fail(`Unable to detect the format of ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/codec",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    CodecRuntime.node,
  ],
})
