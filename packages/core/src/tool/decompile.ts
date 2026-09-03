export * as DecompileTool from "./decompile"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt } from "../schema"
import { read } from "./binary-file"
import { DecompilerRuntime } from "./decompiler-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "decompile"
export const DEFAULT_LENGTH = 64 * 1024
export const MAX_LENGTH = 2 * 1024 * 1024
export const MAX_STRUCTURED_CODE_BYTES = 16 * 1024

export const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({
    description: "Binary file containing the code to decompile. Relative paths resolve from the active Location.",
  }),
  address: NonNegativeInt.annotate({
    description: "Virtual address of the function entry point.",
  }),
  architecture: DecompilerRuntime.Architecture.annotate({
    description: "Instruction set: x86, x86_64, arm, arm64, mips, ppc, or riscv.",
  }),
  endianness: DecompilerRuntime.Endianness.pipe(Schema.optional).annotate({
    description: "Byte order. Defaults to little.",
  }),
  baseAddress: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Virtual address corresponding to file offset 0. Defaults to 0.",
  }),
  fileOffset: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "File offset where the bounded analysis region starts. Defaults to address - baseAddress.",
  }),
  length: NonNegativeInt.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_LENGTH))
    .pipe(Schema.optional)
    .annotate({
      description: `Maximum bytes to analyze from fileOffset. Defaults to ${DEFAULT_LENGTH}; maximum ${MAX_LENGTH}.`,
    }),
})

export const Output = Schema.Struct({
  path: Schema.String,
  address: NonNegativeInt,
  architecture: DecompilerRuntime.Architecture,
  code: Schema.String,
})

const StructuredOutput = Schema.Struct({
  path: Schema.String,
  address: NonNegativeInt,
  architecture: DecompilerRuntime.Architecture,
  code: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const decompiler = yield* DecompilerRuntime.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Decompile one function from a binary into bounded pseudo-C with the bundled Ghidra WebAssembly decompiler. This is static analysis: the binary is never executed and no host decompiler, Java runtime, container, or network download is required. Pass the function virtual address, architecture, byte order, and the virtual address represented by file offset 0.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({ ...output, code: structuredCode(output.code) }),
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `${output.path} ${output.architecture} @ 0x${output.address.toString(16)}\n${output.code}`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (
                (input.architecture === "x86" || input.architecture === "x86_64" || input.architecture === "riscv") &&
                input.endianness === "big"
              )
                return yield* new ToolFailure({ message: `${input.architecture} supports little-endian input only` })
              const file = yield* read(input.path, name, context, mutation, fs, permission)
              const baseAddress = input.baseAddress ?? 0
              const fileOffset = input.fileOffset ?? input.address - baseAddress
              if (input.address < baseAddress || fileOffset < 0 || fileOffset >= file.bytes.length)
                return yield* new ToolFailure({
                  message: `Address 0x${input.address.toString(16)} is outside ${input.path} for base address 0x${baseAddress.toString(16)}`,
                })
              const bytes = file.bytes.subarray(
                fileOffset,
                Math.min(file.bytes.length, fileOffset + (input.length ?? DEFAULT_LENGTH)),
              )
              const code = yield* decompiler
                .decompile({
                  bytes,
                  architecture: input.architecture,
                  endianness: input.endianness ?? "little",
                  baseAddress: baseAddress + fileOffset,
                  address: input.address,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to decompile ${input.path}: ${error.message}` }),
                  ),
                )
              if (/^(?:Lowlevel|Decoder|Standard|Literal) Error:|^Unknown error|^Error:/m.test(code))
                return yield* new ToolFailure({ message: code.trim() })
              return { path: file.resource, address: input.address, architecture: input.architecture, code }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to decompile ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/decompile",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, DecompilerRuntime.node],
})

function structuredCode(code: string) {
  if (Buffer.byteLength(code, "utf8") <= MAX_STRUCTURED_CODE_BYTES) return code
  const marker = "\n... structured decompile preview truncated; full output is retained ...\n"
  const available = Math.max(0, MAX_STRUCTURED_CODE_BYTES - Buffer.byteLength(marker, "utf8"))
  const head = Math.floor(available / 2)
  const tail = available - head
  return `${code.slice(0, head)}${marker}${code.slice(-tail)}`
}
