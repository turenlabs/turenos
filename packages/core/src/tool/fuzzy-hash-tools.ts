export * as FuzzyHashTools from "./fuzzy-hash-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { read } from "./binary-file"
import { FuzzyHashRuntime } from "./fuzzy-hash-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_HASH_TEXT = 4096

const algorithm = Schema.Literals(["ssdeep", "tlsh"]).annotate({
  description: "Similarity hash algorithm: ssdeep (block:hash:hash) or tlsh (T1... form).",
})

const digest = (description: string) =>
  Schema.NonEmptyString.check(Schema.isMaxLength(MAX_HASH_TEXT)).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* FuzzyHashRuntime.Service

    const run = Effect.fn("FuzzyHashTools.run")(function* (request: FuzzyHashRuntime.Request, label: string) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run ${request.op} on ${label}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message }),
      )

    yield* tools
      .register({
        hash_all: Tool.make({
          deferred: true,
          description:
            "Compute MD5, SHA-1, SHA-256, SHA-512, BLAKE3, xxHash64, and the PE import hash (imphash) over one local file in a single pass. Bounded to 32 MiB, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "File to hash." }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "hash_all", context, mutation, fs, permission)
              const report = yield* run({ op: "hash_all", bytes: file.bytes }, input.path)
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to hash ${input.path}`)),
        }),
        fuzzy_hash: Tool.make({
          deferred: true,
          description:
            "Compute a similarity hash (ssdeep or TLSH) over one local file for malware triage and near-duplicate comparison. Bounded to 32 MiB, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "File to fuzzy-hash." }),
            algorithm,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "fuzzy_hash", context, mutation, fs, permission)
              const report = yield* run(
                { op: "fuzzy_hash", bytes: file.bytes, algorithm: input.algorithm },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to fuzzy-hash ${input.path}`)),
        }),
        fuzzy_compare: Tool.make({
          deferred: true,
          description:
            "Compare two similarity digest strings produced by fuzzy_hash. ssdeep reports a 0-100 similarity score; TLSH reports a distance where 0 is identical. Pure string comparison, bounded and offline.",
          input: Schema.Struct({
            algorithm,
            hashA: digest("First digest string, e.g. a hash value returned by fuzzy_hash."),
            hashB: digest("Second digest string to compare against the first."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input) =>
            Effect.gen(function* () {
              const label = `${input.algorithm} digest comparison`
              const report = yield* run(
                { op: "fuzzy_compare", algorithm: input.algorithm, hashA: input.hashA, hashB: input.hashB },
                label,
              )
              return { path: label, report: JSON.stringify(report, null, 2) }
            }).pipe(fail("Unable to compare digests")),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/fuzzy-hash",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, FuzzyHashRuntime.node],
})
