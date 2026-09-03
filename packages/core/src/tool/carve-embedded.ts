export * as CarveEmbeddedTool from "./carve-embedded"

import { createHash, timingSafeEqual } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolOutputStore } from "../tool-output-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_CARVE_BYTES = 128 * 1024 * 1024
const SafeNonNegativeInt = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/)).annotate({
  description: "Optional expected SHA-256 digest. The artifact is not created when it does not match.",
})

export const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "Source file containing the selected byte range." }),
  offset: SafeNonNegativeInt.annotate({ description: "Zero-based byte offset where carving begins." }),
  length: SafeNonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: MAX_CARVE_BYTES })).annotate({
    description: "Exact number of bytes to extract. Maximum 128 MiB.",
  }),
  expectedSha256: Sha256.pipe(Schema.optional),
})

export const Output = Schema.Struct({
  path: Schema.String,
  artifactPath: Schema.String,
  offset: Schema.Int,
  length: Schema.Int,
  sha256: Schema.String,
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    yield* tools
      .register({
        carve_embedded: Tool.make({
          description:
            "Extract one explicitly selected byte range from a file into a retention-managed artifact. The range is capped at 128 MiB, and no decompression, recursion, path inference, workspace write, or execution occurs.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Carved ${output.length} bytes from offset ${output.offset} in ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = yield* mutation.resolve({ path: input.path, kind: "file" })
              const sourceInfo = yield* fs.stat(source.canonical)
              if (sourceInfo.type !== "File") return yield* new ToolFailure({ message: `${input.path} is not a file` })
              const permissionSource = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              if (source.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(source.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: permissionSource,
                })
              yield* permission.assert({
                action: "read",
                resources: [source.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: permissionSource,
              })

              const bytes = yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs.open(source.canonical, { flag: "r" })
                  const info = yield* file.stat
                  const finalSource = yield* mutation.resolve({ path: input.path, kind: "file" })
                  if (finalSource.canonical !== source.canonical || finalSource.resource !== source.resource)
                    return yield* new ToolFailure({ message: "Carve source path changed while opening" })
                  const pathInfo = yield* fs.stat(source.canonical)
                  if (info.type !== "File" || pathInfo.type !== "File")
                    return yield* new ToolFailure({ message: `${input.path} is not a file` })
                  if (!sameFile(sourceInfo, info) || !sameFile(info, pathInfo))
                    return yield* new ToolFailure({ message: "Carve source changed while opening" })
                  const size = Number(info.size)
                  if (!Number.isSafeInteger(size) || input.offset > size || input.length > size - input.offset)
                    return yield* new ToolFailure({ message: "Selected carve range exceeds the source file" })
                  yield* file.seek(input.offset, "start")
                  return Option.getOrUndefined(yield* file.readAlloc(input.length))
                }),
              )
              if (!bytes || bytes.length !== input.length)
                return yield* new ToolFailure({ message: "Unable to read the complete selected carve range" })

              const sha256 = createHash("sha256").update(bytes).digest("hex")
              if (input.expectedSha256 && !sameDigest(sha256, input.expectedSha256))
                return yield* new ToolFailure({ message: "Carved range SHA-256 did not match the expected digest" })
              return {
                path: source.resource,
                artifactPath: yield* artifacts.writeBytes(bytes),
                offset: input.offset,
                length: input.length,
                sha256,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to carve ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

function sameDigest(actual: string, expected: string) {
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
}

function sameFile(left: { dev: number; ino: Option.Option<number> }, right: { dev: number; ino: Option.Option<number> }) {
  const leftInode = Option.getOrUndefined(left.ino)
  const rightInode = Option.getOrUndefined(right.ino)
  return leftInode !== undefined && rightInode !== undefined && left.dev === right.dev && leftInode === rightInode
}

export const node = makeLocationNode({
  name: "tool/carve-embedded",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, ToolOutputStore.node],
})
