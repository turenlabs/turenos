export * as StaticAnalysisTools from "./static-analysis-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { StaticAnalysisRuntime } from "./static-analysis-runtime"
import { Tool } from "./tool"
import { Tools } from "./tools"

const Path = Schema.NonEmptyString.annotate({
  description: "File to analyze. Relative paths resolve from the active Location.",
})
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })
const ExtractOutput = Schema.Struct({
  path: Schema.String,
  outputPath: Schema.String,
  name: Schema.String,
  size: NonNegativeInt,
  sha256: Schema.String,
})

const operations = [
  [
    "identify_file",
    "Identify one file's magic, MIME type, and extension with the bundled infer WebAssembly runtime. The file is never executed.",
  ],
  [
    "hash_digest",
    "Compute a bounded cryptographic digest of one file with the bundled WebAssembly runtime. Supports md5, sha1, sha256, sha512, blake3, and crc32.",
  ],
  ["entropy_scan", "Compute Shannon entropy for one file and bounded windows with the bundled WebAssembly runtime."],
  [
    "fuzzy_hash",
    "Compute a TLSH fuzzy hash of one file with the bundled WebAssembly runtime. Inputs shorter than 50 bytes return no digest.",
  ],
  [
    "import_hash",
    "Compute a PE imphash and bounded import list with Goblin compiled to WebAssembly. Non-PE inputs return an empty result.",
  ],
  [
    "disassemble",
    "Disassemble a bounded x86/x64 byte range with iced-x86 compiled to WebAssembly. The bytes are never executed.",
  ],
  [
    "scan_embedded",
    "Scan one file for bounded embedded signatures such as ELF, PE, ZIP, PDF, gzip, PNG, JPEG, RAR, and 7z. This is scan-only; it does not extract to disk.",
  ],
  [
    "detect_packer",
    "Detect common packer markers such as UPX, MPRESS, Themida, and ASPack from bytes and PE section names.",
  ],
  ["list_archive", "List ZIP or tar archive members from bytes without writing extracted paths to disk."],
  [
    "parse_pdf",
    "Parse bounded PDF header, object, stream, JavaScript, Launch, OpenAction, and encryption indicators from bytes.",
  ],
  ["parse_ole", "List Compound File Binary / OLE streams from one file with the bundled CFB WebAssembly runtime."],
  [
    "office_inspect",
    "Inspect one Office document with the bundled bounded WebAssembly parser. Returns document metadata, embedded relationships, and security-relevant indicators without opening or executing the document.",
  ],
  ["parse_exif", "Parse bounded EXIF fields from JPEG, TIFF, PNG, HEIF, or WebP bytes."],
  ["parse_certificate", "Parse one DER X.509 certificate's subject, issuer, serial, and validity window."],
  ["parse_plist", "Parse a bounded XML or binary plist into a truncated JSON summary."],
  ["parse_lnk", "Parse a Windows Shell Link header and advertised feature flags from bytes."],
  ["parse_minidump", "Parse a bounded Windows minidump directory of stream types, sizes, and RVAs."],
  ["parse_dotnet", "Report whether a PE file contains CLR metadata and return a bounded import sample."],
  ["inspect_overlay", "Measure PE or ELF overlay size, offset, entropy, and a bounded hex preview."],
] as const

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* StaticAnalysisRuntime.Service
    const failure = (action: string, path: string) => (error: Error) =>
      new ToolFailure({ message: `${action} ${path}: ${error.message}` })
    const analyzeFile = (operation: string, path: string, options: Record<string, unknown>, context: Tool.Context) =>
      Effect.gen(function* () {
        const file = yield* read(path, operation, context, mutation, fs, permission)
        const result = yield* runtime
          .analyze({ operation, bytes: file.bytes, options })
          .pipe(Effect.mapError(failure("Unable to analyze", path)))
        return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
      }).pipe(Effect.mapError(toToolFailure(`Unable to analyze ${path}`)))

    const registered = Object.fromEntries([
      ...operations.map(([name, description]) => [
        name,
        Tool.make({
          description,
          input: extraInput(name),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) => analyzeFile(name, input.path, optionsFrom(name, input), context),
        }),
      ]),
      [
        "extract_archive_entry",
        Tool.make({
          description:
            "Extract one ZIP or tar member into a separately specified output file with the bundled WebAssembly runtime. Archive paths are never written; only the selected entry bytes are created at outputPath.",
          input: Schema.Struct({
            path: Path,
            outputPath: Schema.NonEmptyString.annotate({ description: "Destination file for the extracted entry." }),
            index: NonNegativeInt.check(Schema.isLessThanOrEqualTo(4095)).pipe(Schema.optional).annotate({
              description: "Zero-based archive member index. Defaults to 0.",
            }),
            maxOutputBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(8 * 1024 * 1024))
              .pipe(Schema.optional)
              .annotate({
                description: "Maximum extracted entry size. Defaults to 1 MiB; maximum 8 MiB.",
              }),
          }),
          output: ExtractOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Extracted ${output.name} (${output.size} bytes, sha256 ${output.sha256}) to ${output.outputPath}`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = yield* read(input.path, "extract_archive_entry", context, mutation, fs, permission)
              const target = yield* mutation.resolve({ path: input.outputPath, kind: "file" })
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
              const analyzed = yield* runtime
                .analyze({
                  operation: "extract_archive_entry",
                  bytes: source.bytes,
                  options: { index: input.index ?? 0, maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024 },
                })
                .pipe(Effect.mapError(failure("Unable to extract", input.path)))
              const payload = analyzed.result as {
                name?: string
                size?: number
                sha256?: string
                contentBase64?: string
              }
              if (!payload.contentBase64)
                return yield* new ToolFailure({
                  message: payload.name ? `Unable to extract ${payload.name}` : "Unable to extract archive entry",
                })
              const bytes = Buffer.from(payload.contentBase64, "base64")
              const finalTarget = yield* mutation.resolve({ path: input.outputPath, kind: "file" })
              if (finalTarget.canonical !== target.canonical || finalTarget.resource !== target.resource)
                return yield* new ToolFailure({ message: "Extract output path changed during analysis" })
              yield* files
                .create({ target: finalTarget, content: bytes })
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to write ${input.outputPath}` })))
              return {
                path: source.resource,
                outputPath: target.resource,
                name: payload.name ?? `entry-${input.index ?? 0}`,
                size: payload.size ?? bytes.length,
                sha256: payload.sha256 ?? "",
              }
            }).pipe(Effect.mapError(toToolFailure(`Unable to extract ${input.path}`))),
        }),
      ],
      [
        "demangle_symbol",
        Tool.make({
          description:
            "Demangle one Rust or Itanium C++ symbol with the bundled WebAssembly runtime. No file is read or executed.",
          input: Schema.Struct({
            symbol: Schema.NonEmptyString.check(Schema.isMaxLength(4096)).annotate({
              description: "Mangled symbol to recover.",
            }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input) =>
            runtime
              .analyze({ operation: "demangle_symbol", bytes: new Uint8Array([0]), options: { symbol: input.symbol } })
              .pipe(
                Effect.map((result) => ({ path: input.symbol, report: JSON.stringify(result, null, 2) })),
                Effect.mapError(failure("Unable to demangle", input.symbol)),
              ),
        }),
      ],
    ])

    yield* tools.register(registered).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/static-analysis",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FileMutation.node,
    FSUtil.node,
    PermissionV2.node,
    StaticAnalysisRuntime.node,
  ],
})

function extraInput(name: string) {
  if (name === "hash_digest")
    return Schema.Struct({
      path: Path,
      algorithm: Schema.Literals(["md5", "sha1", "sha256", "sha512", "blake3", "crc32"])
        .pipe(Schema.optional)
        .annotate({
          description: "Digest algorithm. Defaults to sha256.",
        }),
    })
  if (name === "entropy_scan")
    return Schema.Struct({
      path: Path,
      window: PositiveInt.check(Schema.isBetween({ minimum: 16, maximum: 4096 }))
        .pipe(Schema.optional)
        .annotate({
          description: "Entropy window size in bytes. Defaults to 256; range 16-4096.",
        }),
    })
  if (name === "disassemble")
    return Schema.Struct({
      path: Path,
      offset: NonNegativeInt.pipe(Schema.optional).annotate({
        description: "File offset to start disassembly. Defaults to 0.",
      }),
      length: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)).pipe(Schema.optional).annotate({
        description: "Number of bytes to disassemble. Defaults to 64; maximum 4096.",
      }),
      bitness: Schema.Literals([16, 32, 64])
        .pipe(Schema.optional)
        .annotate({ description: "Instruction width. Defaults to 64." }),
      address: NonNegativeInt.pipe(Schema.optional).annotate({
        description: "Virtual address for the first instruction. Defaults to offset.",
      }),
    })
  if (name === "scan_embedded")
    return Schema.Struct({
      path: Path,
      maxResults: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)).pipe(Schema.optional).annotate({
        description: "Maximum embedded findings. Defaults to 64; maximum 4096.",
      }),
    })
  return Schema.Struct({ path: Path })
}

function optionsFrom(name: string, input: Record<string, unknown>) {
  if (name === "hash_digest") return { algorithm: input.algorithm ?? "sha256" }
  if (name === "entropy_scan") return { window: input.window ?? 256 }
  if (name === "disassemble")
    return {
      offset: input.offset ?? 0,
      length: input.length ?? 64,
      bitness: input.bitness ?? 64,
      address: input.address,
    }
  if (name === "scan_embedded") return { maxResults: input.maxResults ?? 64 }
  return {}
}

function toToolFailure(message: string) {
  return (error: unknown) =>
    error instanceof ToolFailure
      ? error
      : new ToolFailure({ message: error instanceof Error ? `${message}: ${error.message}` : message })
}
