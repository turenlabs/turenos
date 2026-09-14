export * as SourcemapTools from "./sourcemap-tools"

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
import { SourcemapRuntime } from "./sourcemap-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_LIST = 4096

const boundedList = (description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LIST))
    .pipe(Schema.optional)
    .annotate({ description: `${description} Hard maximum ${MAX_LIST}.` })

const FilePath = Schema.NonEmptyString.annotate({ description: "Local .map source-map file." })
const SourcePath = Schema.NonEmptyString.annotate({
  description:
    "Source path inside the map (for example `app.js`). Exact match first, then ./-normalized, then a /-boundary suffix match.",
})
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })
const BytesOutput = Schema.Struct({
  path: Schema.String,
  artifactPath: Schema.String,
  bytes: Schema.Int,
  sha256: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* SourcemapRuntime.Service

    const run = Effect.fn("SourcemapTools.run")(function* (request: SourcemapRuntime.Request, path: string) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) => (error instanceof ToolFailure ? error : new ToolFailure({ message })))

    const report = Effect.fn("SourcemapTools.report")(function* (
      op: "sourcemap_inspect" | "sourcemap_lookup" | "sourcemap_reverse_lookup",
      path: string,
      options: Readonly<Record<string, unknown>>,
      context: Tool.Context,
    ) {
      const file = yield* read(path, op, context, mutation, fs, permission)
      const result = yield* run({ op, bytes: file.bytes, options }, path)
      if (result.type !== "report")
        return yield* new ToolFailure({ message: `${op} returned an unexpected byte result` })
      return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result.report }, null, 2) }
    })

    const extract = Effect.fn("SourcemapTools.extract")(function* (
      op: "sourcemap_flatten" | "sourcemap_source",
      path: string,
      options: Readonly<Record<string, unknown>>,
      context: Tool.Context,
    ) {
      const file = yield* read(path, op, context, mutation, fs, permission)
      const result = yield* run({ op, bytes: file.bytes, options }, path)
      if (result.type !== "bytes")
        return yield* new ToolFailure({ message: `${op} returned an unexpected report result` })
      return {
        path: file.resource,
        artifactPath: yield* artifacts.writeBytes(result.bytes),
        bytes: result.bytes.length,
        sha256: createHash("sha256").update(result.bytes).digest("hex"),
      }
    })

    yield* tools
      .register({
        sourcemap_inspect: Tool.make({
          deferred: true,
          description:
            "Summarize a local .map source-map file: kind (regular, index, or Hermes), sources with per-source content size and SHA-256 (contents are never inlined), name/mapping counts, and index-map section metadata. Bounded and offline; external section URLs are reported but never fetched.",
          input: Schema.Struct({
            path: FilePath,
            maxSources: boundedList("Maximum sources listed. Defaults to 4096."),
            maxSections: boundedList("Maximum index-map sections listed. Defaults to 4096."),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "sourcemap_inspect",
              input.path,
              {
                maxSources: input.maxSources,
                maxSections: input.maxSections,
              },
              context,
            ).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        sourcemap_lookup: Tool.make({
          deferred: true,
          description:
            "Map a 0-indexed generated (minified) line/column to the closest original source token in a local .map file. Positions between mappings resolve to the preceding token; bounded, offline, and external sections are never fetched.",
          input: Schema.Struct({
            path: FilePath,
            line: NonNegativeInt.annotate({ description: "0-indexed generated line." }),
            column: NonNegativeInt.annotate({ description: "0-indexed generated column." }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("sourcemap_lookup", input.path, { line: input.line, column: input.column }, context).pipe(
              fail(`Unable to look up ${input.line}:${input.column} in ${input.path}`),
            ),
        }),
        sourcemap_reverse_lookup: Tool.make({
          deferred: true,
          description:
            "Map an original source position to the generated (minified) positions it produced in a local .map file — for tracing minified output back from an original line. Index maps are flattened first; bounded and offline.",
          input: Schema.Struct({
            path: FilePath,
            source: SourcePath.pipe(Schema.optional),
            sourceIndex: NonNegativeInt.pipe(Schema.optional).annotate({
              description: "Index into the map's source list; takes precedence over source.",
            }),
            line: NonNegativeInt.annotate({ description: "0-indexed original line." }),
            column: NonNegativeInt.pipe(Schema.optional).annotate({
              description: "0-indexed original column. Omit to match every mapping on the line.",
            }),
            maxPositions: boundedList("Maximum generated positions returned. Defaults to 4096."),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.source === undefined && input.sourceIndex === undefined)
                return yield* new ToolFailure({ message: "sourcemap_reverse_lookup requires source or sourceIndex" })
              return yield* report(
                "sourcemap_reverse_lookup",
                input.path,
                {
                  source: input.source,
                  sourceIndex: input.sourceIndex,
                  line: input.line,
                  column: input.column,
                  maxPositions: input.maxPositions,
                },
                context,
              )
            }).pipe(fail(`Unable to reverse look up ${input.path}`)),
        }),
        sourcemap_source: Tool.make({
          deferred: true,
          description:
            "Extract one embedded sourcesContent entry from a local .map file by index or source path as raw bytes — for recovering original source from minified JavaScript. The entry is written to a retention-managed artifact; index maps are flattened first.",
          input: Schema.Struct({
            path: FilePath,
            index: NonNegativeInt.pipe(Schema.optional).annotate({
              description: "Index into the flattened source list; takes precedence over source.",
            }),
            source: SourcePath.pipe(Schema.optional),
          }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte embedded source from ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.index === undefined && input.source === undefined)
                return yield* new ToolFailure({ message: "sourcemap_source requires index or source" })
              const options = input.index !== undefined ? { index: input.index } : { path: input.source }
              return yield* extract("sourcemap_source", input.path, options, context)
            }).pipe(fail(`Unable to extract a source from ${input.path}`)),
        }),
        sourcemap_flatten: Tool.make({
          deferred: true,
          description:
            "Resolve a sectioned index sourcemap (or normalize a regular or Hermes map) into a single regular v3 sourcemap. The flattened map JSON is written to a retention-managed artifact; external sections are never fetched.",
          input: Schema.Struct({ path: FilePath }),
          output: BytesOutput,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Wrote ${output.bytes}-byte flattened sourcemap for ${output.path} to ${output.artifactPath} (sha256 ${output.sha256})`,
            },
          ],
          execute: (input, context) =>
            extract("sourcemap_flatten", input.path, {}, context).pipe(fail(`Unable to flatten ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/sourcemap",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    SourcemapRuntime.node,
  ],
})
