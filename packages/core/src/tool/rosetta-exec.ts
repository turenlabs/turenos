export * as RosettaExecTool from "./rosetta-exec"

import { ToolFailure } from "@turenlabs/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AppProcess } from "../process"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "rosetta_exec"
export const HARNESS_ENV = "TUREN_ROSETTA_HARNESS"
export const KERNEL_ENV = "TUREN_ROSETTA_KERNEL"
export const INITRD_ENV = "TUREN_ROSETTA_INITRD"
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024

const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "x86-64 Linux ELF executable to run through Apple Rosetta." }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({ description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.` }),
})

const Output = Schema.Struct({
  exit: Schema.Number,
  output: Schema.String,
  truncated: Schema.Boolean,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const appProcess = yield* AppProcess.Service

    yield* tools
      .register({
        [name]: Tool.make({
          deferred: true,
          description:
            "Run one permission-checked x86-64 Linux ELF through TurenOS's first-party Apple Virtualization.framework harness and Rosetta. The execution pack is local, diskless, networkless, and controlled by TurenOS; no Docker, Colima, Lima, Tart, shell, or user-provided VM path is used.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output || `Process exited ${output.exit}.` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (process.platform !== "darwin" || process.arch !== "arm64")
                return yield* new ToolFailure({ message: `${name} requires Apple Silicon macOS` })
              const helper = process.env[HARNESS_ENV]
              const kernel = process.env[KERNEL_ENV]
              const initrd = process.env[INITRD_ENV]
              if (!helper || !kernel || !initrd)
                return yield* new ToolFailure({
                  message: `${name} is unavailable: install TurenOS's local Rosetta execution pack first`,
                })

              const target = yield* mutation.resolve({ path: input.path, kind: "file" })
              const file = yield* read(input.path, name, context, mutation, fs, permission)
              if (!isX86_64Elf(file.bytes))
                return yield* new ToolFailure({ message: `${name} accepts only little-endian x86-64 ELF files` })

              const result = yield* appProcess
                .run(
                  ChildProcess.make(
                    helper,
                    [
                      "--kernel",
                      kernel,
                      "--initrd",
                      initrd,
                      "--executable",
                      target.canonical,
                      "--timeout",
                      String(Math.ceil((input.timeout ?? DEFAULT_TIMEOUT_MS) / 1000)),
                    ],
                    { stdin: "ignore", detached: true, forceKillAfter: Duration.seconds(3) },
                  ),
                  {
                    combineOutput: true,
                    timeout: Duration.millis((input.timeout ?? DEFAULT_TIMEOUT_MS) + 5_000),
                    maxOutputBytes: MAX_OUTPUT_BYTES,
                  },
                )
                .pipe(
                  Effect.mapError(
                    () => new ToolFailure({ message: `Unable to run ${input.path} through TurenOS's Rosetta harness` }),
                  ),
                )
              const envelope = JSON.parse(result.output?.toString("utf8") ?? "{}") as {
                exit?: number
                output?: string
              }
              return {
                exit: envelope.exit ?? 255,
                output: envelope.output ?? "",
                truncated: result.outputTruncated === true,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to run ${input.path} through TurenOS's Rosetta harness` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/rosetta-exec",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, AppProcess.node],
})

export function isX86_64Elf(bytes: Uint8Array) {
  return (
    bytes.length >= 20 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46 &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    bytes[18] === 0x3e &&
    bytes[19] === 0
  )
}
