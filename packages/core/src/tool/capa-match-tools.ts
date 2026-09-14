export * as CapaMatchTools from "./capa-match-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { CapaMatchRuntime } from "./capa-match-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 4096
const MAX_STRINGS = 4096

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const flag = (description: string) => Schema.Boolean.pipe(Schema.optional).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* CapaMatchRuntime.Service

    const run = Effect.fn("CapaMatchTools.run")(function* (request: CapaMatchRuntime.Request, path: string) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message }),
      )

    yield* tools
      .register({
        capa_match: Tool.make({
          deferred: true,
          description:
            "Match one local file against the embedded Mandiant capa-rules ruleset (~1,050 rules) and report matched capabilities with hits, evidence, ATT&CK/MBC mappings, and per-reason skip counts. This is a static-subset matcher with no disassembly: only file-scope features (format/arch/os, sections, imports, exports, strings, byte patterns, embedded-PE and forwarded-export characteristics) are observed, so rules needing function- or instruction-scope features are skipped as static-scope-unsupported. Reported matches are a LOWER BOUND of the file's true capabilities — a missing rule does not prove the capability is absent. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("File to match against the embedded capa-rules ruleset."),
            maxResults: boundedInt(
              MAX_RESULTS,
              `Maximum matched rules emitted; capability_count still reports the true total. Defaults to ${MAX_RESULTS}; hard maximum ${MAX_RESULTS}.`,
            ),
            includeEvidence: flag("Emit per-rule evidence entries. Defaults to true."),
            includeSkipped: flag("Additionally emit the skipped-rules list with per-rule reasons. Defaults to false."),
            includeLib: flag(
              "Include lib helper rules in the report; they still evaluate either way so match references resolve. Defaults to false.",
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "capa_match", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "capa_match",
                  bytes: file.bytes,
                  options: {
                    maxResults: input.maxResults,
                    includeEvidence: input.includeEvidence,
                    includeSkipped: input.includeSkipped,
                    includeLib: input.includeLib,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to run capa_match on ${input.path}`)),
        }),
        capa_features: Tool.make({
          deferred: true,
          description:
            "Report the file-scope feature set extracted from one local file for capa matching: format/os/arch, sections with entropy, libraries, imports and exports, ASCII/UTF-16LE string statistics with a bounded distinct-value sample, embedded-PE offsets, and the forwarded-export flag. No disassembly is performed. Bounded, offline, never executes input.",
          input: Schema.Struct({
            path: FilePath("File to extract capa features from."),
            maxStrings: boundedInt(
              MAX_STRINGS,
              `Bounds the api/import/string sample lists. Defaults to 256; hard maximum ${MAX_STRINGS}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "capa_features", context, mutation, fs, permission)
              const report = yield* run(
                { op: "capa_features", bytes: file.bytes, options: { maxStrings: input.maxStrings } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to run capa_features on ${input.path}`)),
        }),
        capa_ruleset: Tool.make({
          deferred: true,
          description:
            "Report metadata about the embedded capa-rules ruleset used by capa_match: provenance commit, imported flag, rule/library/degraded/evaluable counts, per-reason skip counts, namespaces, unsupported feature kinds, and embedded byte-pattern count. Takes no file input; offline.",
          input: Schema.Struct({
            verbose: flag("Additionally emit the full rule list. Defaults to false."),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input) =>
            Effect.gen(function* () {
              const report = yield* run({ op: "capa_ruleset", options: { verbose: input.verbose } }, "capa_ruleset")
              return { path: "<embedded capa-rules ruleset>", report: JSON.stringify(report, null, 2) }
            }).pipe(fail("Unable to report the capa ruleset")),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/capa-match",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, CapaMatchRuntime.node],
})
