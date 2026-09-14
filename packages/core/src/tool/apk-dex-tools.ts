export * as ApkDexTools from "./apk-dex-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ApkDexRuntime } from "./apk-dex-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ENTRIES = 4096
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_XML_BYTES = 1024 * 1024
const MAX_DEX_INDEX = 64

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* ApkDexRuntime.Service

    const run = Effect.fn("ApkDexTools.run")(function* (request: ApkDexRuntime.Request, path: string) {
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
        axml_decode: Tool.make({
          deferred: true,
          description:
            "Decode an Android binary XML (AXML) file — a compiled AndroidManifest.xml or any res/ XML — into bounded text XML with element/attribute counts, namespaces, string-pool facts, and warnings. Typed values render per AOSP rules. Parse only, offline, never executes input.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Binary XML file to decode." }),
            maxXmlBytes: boundedInt(
              MAX_XML_BYTES,
              `Maximum decoded XML bytes returned. Defaults to ${MAX_XML_BYTES}; hard maximum ${MAX_XML_BYTES}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "axml_decode", context, mutation, fs, permission)
              const report = yield* run(
                { op: "axml_decode", bytes: file.bytes, options: { maxXmlBytes: input.maxXmlBytes } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to decode ${input.path}`)),
        }),
        dex_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one Dalvik .dex file (or classesN.dex inside an APK/ZIP input): header version, checksum and SHA-1 signature, table geometry, counts, strings, protos, classes with method stats, map entries, and security findings (reflection, dynamic loading, crypto, exec, su, native). Parse only — bytecode is counted, never executed or emulated.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "DEX file (or APK/ZIP) to inspect." }),
            dexIndex: boundedInt(
              MAX_DEX_INDEX,
              `When the input is an APK/ZIP, selects classesN.dex (1 = classes.dex). Defaults to 1; hard maximum ${MAX_DEX_INDEX}.`,
            ),
            limit: boundedInt(
              MAX_ENTRIES,
              `Maximum strings/protos/classes rows reported. Defaults to ${MAX_ENTRIES}; hard maximum ${MAX_ENTRIES}.`,
            ),
            includeStrings: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Include the bounded string table in the report. Defaults to true.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "dex_inspect", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "dex_inspect",
                  bytes: file.bytes,
                  options: {
                    dexIndex: input.dexIndex,
                    limit: input.limit,
                    includeStrings: input.includeStrings,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        apk_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect an Android APK as a ZIP container: entry table, decoded AndroidManifest AXML, dex file list with SHA-256 and dex versions, resources.arsc package names, and detected signing blocks (v2/v3/v3.1 scheme IDs plus v1 META-INF files). Signing is detected, never verified; entries are read in memory and nothing is extracted to disk.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "APK file to inspect." }),
            decodeManifest: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Decode AndroidManifest.xml AXML into the report. Defaults to true.",
            }),
            dexDetails: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Embed a compact dex_inspect report per dex file. Defaults to false.",
            }),
            maxEntries: boundedInt(
              MAX_ENTRIES,
              `Maximum ZIP entries reported. Defaults to ${MAX_ENTRIES}; hard maximum ${MAX_ENTRIES}.`,
            ),
            maxEntryBytes: boundedInt(
              MAX_ENTRY_BYTES,
              `Per-entry decompressed byte cap. Defaults to ${MAX_ENTRY_BYTES}; hard maximum ${MAX_ENTRY_BYTES}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "apk_inspect", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "apk_inspect",
                  bytes: file.bytes,
                  options: {
                    decodeManifest: input.decodeManifest,
                    dexDetails: input.dexDetails,
                    maxEntries: input.maxEntries,
                    maxEntryBytes: input.maxEntryBytes,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/apk-dex",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, ApkDexRuntime.node],
})
