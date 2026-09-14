export * as BinaryDiffTools from "./binary-diff-tools"

import { createHash } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolOutputStore } from "../tool-output-store"
import { read } from "./binary-file"
import { BinaryDiffRuntime } from "./binary-diff-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_REGIONS = 4096

const maxRegions = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_REGIONS))
  .pipe(Schema.optional)
  .annotate({ description: `Maximum changed regions returned. Hard maximum ${MAX_REGIONS}.` })

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* BinaryDiffRuntime.Service

    const run = Effect.fn("BinaryDiffTools.run")(function* (request: BinaryDiffRuntime.Request, path: string) {
      const result = yield* runtime
        .run(request)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` })))
      return result
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message }),
      )

    yield* tools
      .register({
        binary_compare: Tool.make({
          deferred: true,
          description:
            "Compare two local binary files byte-for-byte: identity, size delta, common prefix/suffix, changed regions with hex previews and entropy, SHA-256 of each input, and a 0-100 similarity score. Bounded, offline, never executes input.",
          input: Schema.Struct({
            old: FilePath("Baseline file to compare."),
            next: FilePath("Candidate file to compare against the baseline."),
            maxRegions,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const old = yield* read(input.old, "binary_compare", context, mutation, fs, permission)
              const next = yield* read(input.next, "binary_compare", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "binary_compare",
                  old: old.bytes,
                  next: next.bytes,
                  options: { maxRegions: input.maxRegions ?? MAX_REGIONS },
                },
                input.old,
              )
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "binary_compare returned an unexpected byte result" })
              return { path: `${old.resource} <-> ${next.resource}`, report: JSON.stringify(result.report, null, 2) }
            }).pipe(fail(`Unable to compare ${input.old}`)),
        }),
        binary_regions: Tool.make({
          deferred: true,
          description:
            "Report the changed byte regions between two local binary files using an exact aligned or rolling-hash scan. Cheaper than a full diff; good for locating where firmware images differ.",
          input: Schema.Struct({
            old: FilePath("Baseline file."),
            next: FilePath("Candidate file."),
            maxRegions,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const old = yield* read(input.old, "binary_regions", context, mutation, fs, permission)
              const next = yield* read(input.next, "binary_regions", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "binary_regions",
                  old: old.bytes,
                  next: next.bytes,
                  options: { maxRegions: input.maxRegions ?? MAX_REGIONS },
                },
                input.old,
              )
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "binary_regions returned an unexpected byte result" })
              return { path: `${old.resource} <-> ${next.resource}`, report: JSON.stringify(result.report, null, 2) }
            }).pipe(fail(`Unable to compare ${input.old}`)),
        }),
        binary_patch_info: Tool.make({
          deferred: true,
          description:
            "Inspect a bipatch-format binary patch file: format validity, control counts, add/copy/output byte totals, truncation, and warnings.",
          input: Schema.Struct({ patch: FilePath("Patch file produced by binary_diff.") }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const patch = yield* read(input.patch, "binary_patch_info", context, mutation, fs, permission)
              const result = yield* run({ op: "binary_patch_info", patch: patch.bytes, options: {} }, input.patch)
              if (result.type !== "report")
                return yield* new ToolFailure({ message: "binary_patch_info returned an unexpected byte result" })
              return { path: patch.resource, report: JSON.stringify(result.report, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.patch}`)),
        }),
        binary_diff: Tool.make({
          deferred: true,
          description:
            "Produce a bipatch-format patch that transforms one local binary file into another. The patch is written to a retention-managed artifact; inputs never execute.",
          input: Schema.Struct({
            old: FilePath("Baseline file the patch starts from."),
            next: FilePath("Target file the patch produces."),
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
              text: `Wrote ${output.bytes}-byte patch for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const old = yield* read(input.old, "binary_diff", context, mutation, fs, permission)
              const next = yield* read(input.next, "binary_diff", context, mutation, fs, permission)
              const result = yield* run({ op: "binary_diff", old: old.bytes, next: next.bytes, options: {} }, input.old)
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "binary_diff returned an unexpected report result" })
              return {
                path: `${old.resource} -> ${next.resource}`,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to diff ${input.old}`)),
        }),
        binary_patch: Tool.make({
          deferred: true,
          description:
            "Apply a bipatch-format patch to a local binary file. The patched output is written to a retention-managed artifact; optionally verified against an expected SHA-256.",
          input: Schema.Struct({
            old: FilePath("Baseline file to patch."),
            patch: FilePath("Patch file produced by binary_diff."),
            expectedSha256: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/))
              .pipe(Schema.optional)
              .annotate({ description: "Optional SHA-256 digest the patched output must match." }),
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
              text: `Wrote ${output.bytes}-byte patched output for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const old = yield* read(input.old, "binary_patch", context, mutation, fs, permission)
              const patch = yield* read(input.patch, "binary_patch", context, mutation, fs, permission)
              const result = yield* run(
                {
                  op: "binary_patch",
                  old: old.bytes,
                  patch: patch.bytes,
                  options: input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {},
                },
                input.old,
              )
              if (result.type !== "bytes")
                return yield* new ToolFailure({ message: "binary_patch returned an unexpected report result" })
              return {
                path: `${old.resource} + ${patch.resource}`,
                artifactPath: yield* artifacts.writeBytes(result.bytes),
                bytes: result.bytes.length,
                sha256: createHash("sha256").update(result.bytes).digest("hex"),
              }
            }).pipe(fail(`Unable to patch ${input.old}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/binary-diff",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    BinaryDiffRuntime.node,
  ],
})
