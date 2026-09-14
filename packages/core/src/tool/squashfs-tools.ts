export * as SquashfsTools from "./squashfs-tools"

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
import { SquashfsRuntime } from "./squashfs-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 4096
// Serialized extraction payloads must fit the module's ~3 MiB JSON budget.
const MAX_EXTRACT_BYTES = 3 * 1024 * 1024

const offset = NonNegativeInt.pipe(Schema.optional).annotate({
  description: "Byte offset of the SquashFS image inside the file, for firmware containers with leading padding.",
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* SquashfsRuntime.Service

    const run = Effect.fn("SquashfsTools.run")(function* (request: SquashfsRuntime.Request, path: string) {
      return yield* runtime
        .run(request)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` })))
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message }),
      )

    yield* tools
      .register({
        squashfs_list: Tool.make({
          deferred: true,
          description:
            "List the entries of one local SquashFS image (v3/v4, gzip/lz4/none compressors): superblock metadata plus a sorted, bounded entry table with path, type, size, mode, uid/gid, mtime, and link targets. Paths inside the image are never interpreted as host paths. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SquashFS image or firmware container to list." }),
            offset,
            pathFilter: Schema.NonEmptyString.pipe(Schema.optional).annotate({
              description: "Directory-prefix filter for entries, for example /etc.",
            }),
            maxResults: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RESULTS))
              .pipe(Schema.optional)
              .annotate({ description: `Maximum entries returned. Hard maximum ${MAX_RESULTS}.` }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "squashfs_list", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "squashfs_list",
                  bytes: file.bytes,
                  options: { offset: input.offset, pathFilter: input.pathFilter, maxResults: input.maxResults },
                },
                input.path,
              )
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "squashfs_list returned an unexpected byte result" })
              return {
                path: file.resource,
                report: JSON.stringify({ path: file.resource, ...result.report }, null, 2),
              }
            }).pipe(fail(`Unable to list ${input.path}`)),
        }),
        squashfs_extract: Tool.make({
          deferred: true,
          description:
            "Extract exactly one regular file from a local SquashFS image by exact normalized entry path. The entry bytes are written to a retention-managed artifact; the image's paths are never written to the filesystem and symlinks are never followed. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SquashFS image or firmware container to extract from." }),
            entry: Schema.NonEmptyString.annotate({
              description: "Exact normalized path of the entry inside the image, for example /etc/passwd.",
            }),
            offset,
            maxBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_EXTRACT_BYTES))
              .pipe(Schema.optional)
              .annotate({
                description: `Preview cap: return at most this many leading bytes of the entry. Hard maximum ${MAX_EXTRACT_BYTES}.`,
              }),
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
              text: `Wrote ${output.bytes}-byte extracted entry for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "squashfs_extract", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "squashfs_extract",
                  bytes: file.bytes,
                  options: { path: input.entry, offset: input.offset, maxBytes: input.maxBytes },
                },
                input.path,
              )
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "squashfs_extract returned an unexpected report result" })
              return {
                path: `${file.resource}:${result.report.path ?? input.entry}`,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to extract ${input.entry} from ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/squashfs",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    SquashfsRuntime.node,
  ],
})
