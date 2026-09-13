export * as BinaryAnalysisTools from "./binary-analysis-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { BinaryAnalysisRuntime } from "./binary-analysis-runtime"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const BinaryInspectInput = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "Executable path to inspect." }),
})
const StringInput = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "File to scan for strings." }),
  minLength: PositiveInt.check(Schema.isLessThanOrEqualTo(1024))
    .pipe(Schema.optional)
    .annotate({ description: "Minimum string length. Defaults to 4." }),
  decode: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Decode Base64, hex, and URL-encoded strings. Defaults to true.",
  }),
  autoXor: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Try all single-byte XOR keys. Limited to 512 KiB inputs.",
  }),
  xorKeyHex: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional hexadecimal XOR key, maximum 64 bytes.",
  }),
})
const CaptureInput = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "Offline PCAP or PCAPNG file." }),
  filter: Schema.String.check(Schema.isMaxLength(4096))
    .pipe(Schema.optional)
    .annotate({ description: "Numeric-only classic BPF filter." }),
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(100_000))
    .pipe(Schema.optional)
    .annotate({ description: "Filtered packet offset. Defaults to 0." }),
  maxPackets: PositiveInt.check(Schema.isLessThanOrEqualTo(256))
    .pipe(Schema.optional)
    .annotate({ description: "Maximum packets returned. Defaults to 64." }),
  maxPacketBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(4096))
    .pipe(Schema.optional)
    .annotate({ description: "Maximum bytes returned per packet. Defaults to 256." }),
})
const UnpackInput = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "UPX- or MPRESS-packed executable." }),
  outputPath: Schema.NonEmptyString.annotate({ description: "Path for the reconstructed executable." }),
  packer: Schema.Literals(["auto", "upx", "mpress"])
    .pipe(Schema.optional)
    .annotate({ description: "Packer selection. Defaults to auto-detection." }),
})
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })
const UnpackOutput = Schema.Struct({
  path: Schema.String,
  outputPath: Schema.String,
  packer: Schema.Literals(["upx", "mpress"]),
  outputSize: NonNegativeInt,
  importsRebuilt: Schema.Boolean,
  runnable: Schema.Boolean,
  entryPoint: Schema.String.pipe(Schema.optional),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* BinaryAnalysisRuntime.Service

    const readBytes = (path: string, action: string, context: Tool.Context) =>
      read(path, action, context, mutation, fs, permission)
    const failure = (action: string, path: string) => (error: Error) =>
      new ToolFailure({ message: `${action} ${path}: ${error.message}` })

    yield* tools
      .register({
        binary_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one PE, ELF, Mach-O, TE, COFF, or Unix archive with the bundled bounded Goblin WebAssembly parser. Returns headers, sections, segments, imports, exports, symbols, libraries, and entry-point metadata without executing the file.",
          input: BinaryInspectInput,
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* readBytes(input.path, "binary_inspect", context)
              const result = yield* runtime
                .inspect(file.bytes)
                .pipe(Effect.mapError(failure("Unable to inspect", input.path)))
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
            }).pipe(Effect.mapError(toToolFailure(`Unable to inspect ${input.path}`))),
        }),
        extract_strings: Tool.make({
          deferred: true,
          description:
            "Recover bounded raw, UTF-16LE, decoded, classified, and XOR-obfuscated strings from one file with the bundled stng-core WebAssembly runtime. The target is never executed and no host string utility is required.",
          input: StringInput,
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* readBytes(input.path, "extract_strings", context)
              const xorKey = yield* parseHexKey(input.xorKeyHex)
              const result = yield* runtime
                .strings({
                  bytes: file.bytes,
                  minLength: input.minLength ?? 4,
                  decode: input.decode ?? true,
                  autoXor: input.autoXor ?? false,
                  xorKey,
                })
                .pipe(Effect.mapError(failure("Unable to extract strings from", input.path)))
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
            }).pipe(Effect.mapError(toToolFailure(`Unable to extract strings from ${input.path}`))),
        }),
        pcap_inspect: Tool.make({
          deferred: true,
          description:
            "Read a bounded page from an offline PCAP or PCAPNG file with the official tcpdump-group libpcap compiled to WebAssembly. Supports numeric classic BPF filters; live capture, devices, paths, dumping, and network access are unavailable.",
          input: CaptureInput,
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* readBytes(input.path, "pcap_inspect", context)
              const result = yield* runtime
                .capture({
                  bytes: file.bytes,
                  filter: input.filter ?? "",
                  offset: input.offset ?? 0,
                  maxPackets: input.maxPackets ?? 64,
                  maxPacketBytes: input.maxPacketBytes ?? 256,
                })
                .pipe(Effect.mapError(failure("Unable to inspect capture", input.path)))
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
            }).pipe(Effect.mapError(toToolFailure(`Unable to inspect capture ${input.path}`))),
        }),
        unpack_static: Tool.make({
          deferred: true,
          description:
            "Statically unpack a standard UPX executable or reconstruct an MPRESS PE32 sample with bundled WebAssembly. The analyzed executable is never run. UPX output is runnable; MPRESS output is analysis-grade and may require import rebuilding.",
          input: UnpackInput,
          output: UnpackOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `${output.packer.toUpperCase()} output written to ${output.outputPath} (${output.outputSize} bytes, imports ${output.importsRebuilt ? "rebuilt" : "not rebuilt"}, ${output.runnable ? "runnable" : "analysis-grade"})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const sourceTarget = yield* mutation.resolve({ path: input.path, kind: "file" })
              const source = yield* readBytes(input.path, "unpack_static", context)
              const target = yield* mutation.resolve({ path: input.outputPath, kind: "file" })
              if (sourceTarget.canonical === target.canonical)
                return yield* new ToolFailure({ message: "Unpack output must differ from the input path" })
              const permissionSource = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              if (target.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: permissionSource,
                })
              yield* permission.assert({
                action: "edit",
                resources: [target.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: permissionSource,
              })
              const unpacked = yield* runtime
                .unpack({ bytes: source.bytes, packer: input.packer ?? "auto" })
                .pipe(Effect.mapError(failure("Unable to unpack", input.path)))
              const finalTarget = yield* mutation.resolve({ path: input.outputPath, kind: "file" })
              if (finalTarget.canonical !== target.canonical || finalTarget.resource !== target.resource)
                return yield* new ToolFailure({ message: "Unpack output path changed during analysis" })
              yield* files
                .create({ target: finalTarget, content: unpacked.bytes })
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to write ${input.outputPath}` })))
              return {
                path: source.resource,
                outputPath: target.resource,
                packer: unpacked.metadata.packer,
                outputSize: unpacked.bytes.length,
                importsRebuilt: unpacked.metadata.importsRebuilt,
                runnable: unpacked.metadata.runnable,
                entryPoint: unpacked.metadata.entryPoint,
              }
            }).pipe(Effect.mapError(toToolFailure(`Unable to unpack ${input.path}`))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/binary-analysis",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FileMutation.node,
    FSUtil.node,
    PermissionV2.node,
    BinaryAnalysisRuntime.node,
  ],
})

function parseHexKey(value?: string) {
  if (!value) return Effect.succeed(new Uint8Array())
  if (value.length > 128 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value))
    return Effect.fail(new ToolFailure({ message: "xorKeyHex must contain at most 128 hexadecimal characters" }))
  return Effect.succeed(Uint8Array.from(Buffer.from(value, "hex")))
}

function toToolFailure(message: string) {
  return (error: unknown) =>
    error instanceof ToolFailure
      ? error
      : new ToolFailure({ message: error instanceof Error ? `${message}: ${error.message}` : message })
}
