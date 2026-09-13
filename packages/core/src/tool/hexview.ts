export * as HexviewTool from "./hexview"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "hexview"
export const DEFAULT_LENGTH = 256
export const MAX_LENGTH = 64 * 1024
export const MIN_WIDTH = 8
export const MAX_WIDTH = 32

export const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({
    description: "Binary file to inspect. Relative paths resolve from the active Location.",
  }),
  offset: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Zero-based byte offset. Defaults to 0.",
  }),
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LENGTH))
    .pipe(Schema.optional)
    .annotate({ description: `Number of bytes to display. Defaults to ${DEFAULT_LENGTH}; maximum ${MAX_LENGTH}.` }),
  width: PositiveInt.check(Schema.isBetween({ minimum: MIN_WIDTH, maximum: MAX_WIDTH }))
    .pipe(Schema.optional)
    .annotate({ description: `Bytes per row. Defaults to 16; range ${MIN_WIDTH}-${MAX_WIDTH}.` }),
})

export const Output = Schema.Struct({
  path: Schema.String,
  offset: NonNegativeInt,
  length: NonNegativeInt,
  bytes: Schema.String,
  nextOffset: NonNegativeInt.pipe(Schema.optional),
  content: Schema.String,
})
type Output = typeof Output.Type

const toModelOutput = (output: Output) =>
  [
    `${output.path} [${hex(output.offset)}..${hex(output.offset + output.length)})`,
    output.content || "[no bytes]",
    ...(output.nextOffset === undefined ? [] : [`[continue with offset ${output.nextOffset}]`]),
  ].join("\n")

const format = (bytes: Uint8Array, offset: number, width: number) =>
  Array.from({ length: Math.ceil(bytes.length / width) }, (_, index) => {
    const rowOffset = offset + index * width
    const row = bytes.subarray(index * width, (index + 1) * width)
    const values = Array.from(row, (byte) => byte.toString(16).padStart(2, "0"))
    const split = values.flatMap((value, valueIndex) => (valueIndex === 8 ? ["", value] : [value])).join(" ")
    const padding = " ".repeat(width * 3 + (width > 8 ? 1 : 0) - split.length)
    const ascii = Array.from(row, (byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("")
    return `${hex(rowOffset)}  ${split}${padding}  |${ascii}|`
  }).join("\n")

const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          deferred: true,
          description:
            "Read a bounded hexadecimal and ASCII view of any file without relying on host utilities. Use this for binary headers, embedded data, offsets, and byte-level verification. Relative paths resolve from the active Location; external absolute paths require external_directory approval.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            read(input.path, name, context, mutation, fs, permission).pipe(
              Effect.flatMap((file) => {
                const offset = input.offset ?? 0
                if (offset >= file.bytes.length)
                  return Effect.fail(
                    new ToolFailure({
                      message: `Offset ${offset} is outside ${input.path} (${file.bytes.length} bytes)`,
                    }),
                  )
                const selected = file.bytes.subarray(
                  offset,
                  Math.min(file.bytes.length, offset + (input.length ?? DEFAULT_LENGTH)),
                )
                const nextOffset = offset + selected.length < file.bytes.length ? offset + selected.length : undefined
                return Effect.succeed({
                  path: file.resource,
                  offset,
                  length: selected.length,
                  bytes: Array.from(selected, (byte) => byte.toString(16).padStart(2, "0")).join(""),
                  ...(nextOffset === undefined ? {} : { nextOffset }),
                  content: format(selected, offset, input.width ?? 16),
                })
              }),
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to view ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/hexview",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node],
})
