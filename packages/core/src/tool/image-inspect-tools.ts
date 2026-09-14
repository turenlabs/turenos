export * as ImageInspectTools from "./image-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ImageInspectRuntime } from "./image-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ENTRIES = 4096
const MAX_TEXT_BYTES = 2048
const MAX_DIMENSION = 4096

const maxEntries = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ENTRIES))
  .pipe(Schema.optional)
  .annotate({ description: `Maximum structure entries returned. Defaults to ${MAX_ENTRIES}; hard maximum ${MAX_ENTRIES}.` })

const maxTextBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TEXT_BYTES))
  .pipe(Schema.optional)
  .annotate({
    description: `Maximum bytes kept per text value; longer values are truncated. Defaults to ${MAX_TEXT_BYTES}; hard maximum ${MAX_TEXT_BYTES}.`,
  })

const FilePath = Schema.NonEmptyString.annotate({ description: "Local image file to inspect." })
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* ImageInspectRuntime.Service

    const report = Effect.fn("ImageInspectTools.report")(function* (
      op: ImageInspectRuntime.Request["op"],
      options: Readonly<Record<string, unknown>>,
      path: string,
      context: Tool.Context,
    ) {
      const file = yield* read(path, op, context, mutation, fs, permission)
      const result = yield* runtime
        .run({ op, bytes: file.bytes, options })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to run ${op} on ${path}: ${error.message}` })))
      return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) => (error instanceof ToolFailure ? error : new ToolFailure({ message })))

    yield* tools
      .register({
        image_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect the structure of a local image file — PNG, JPEG, GIF, BMP, WebP, TIFF, ICO, or AVIF/HEIC — reporting the chunk/segment table, dimensions, EXIF/XMP/ICC presence, trailing bytes after the end-of-image marker, and anomaly flags. Bounded, offline, parse-only; payloads are measured, never decoded or executed.",
          input: Schema.Struct({
            path: FilePath,
            maxEntries,
            maxTextBytes,
            includeText: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Decode and include textual metadata chunks (PNG tEXt/zTXt/iTXt, JPEG COM, etc). Defaults to true.",
            }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "image_inspect",
              {
                max_entries: input.maxEntries,
                max_text_bytes: input.maxTextBytes,
                include_text: input.includeText,
              },
              input.path,
              context,
            ).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        image_exif: Tool.make({
          deferred: true,
          description:
            "Extract EXIF/TIFF tags from a local image's EXIF block — camera make/model, software, timestamps, orientation, signed-decimal GPS coordinates, and a bounded field table. Reports exif_present when the container has no EXIF block; thumbnail bytes only when small, else size plus SHA-256.",
          input: Schema.Struct({
            path: FilePath,
            maxFields: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ENTRIES))
              .pipe(Schema.optional)
              .annotate({ description: `Maximum EXIF fields returned. Defaults to 512; hard maximum ${MAX_ENTRIES}.` }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("image_exif", { max_fields: input.maxFields }, input.path, context).pipe(
              fail(`Unable to read EXIF from ${input.path}`),
            ),
        }),
        image_text_chunks: Tool.make({
          deferred: true,
          description:
            "List every textual metadata value in a local image — PNG tEXt/zTXt/iTXt, JPEG COM and XMP, GIF comments, WebP XMP, TIFF ASCII tags — with location, keyword, and bounded text. Non-UTF-8 payloads surface as hex, so this is the hidden-payload and prompt-injection hunting surface.",
          input: Schema.Struct({
            path: FilePath,
            maxEntries,
            maxTextBytes,
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "image_text_chunks",
              { max_entries: input.maxEntries, max_text_bytes: input.maxTextBytes },
              input.path,
              context,
            ).pipe(fail(`Unable to read text chunks from ${input.path}`)),
        }),
        image_pixel_stats: Tool.make({
          deferred: true,
          description:
            "Compute bounded pixel statistics for a local PNG or JPEG: a 16-bin luma histogram plus per-channel means over a deterministic strided sample. Dimensions are checked from the header before decode and anything over the cap is refused; other formats report unsupported_format.",
          input: Schema.Struct({
            path: FilePath,
            maxDimension: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_DIMENSION))
              .pipe(Schema.optional)
              .annotate({
                description: `Largest width or height accepted for decode. Defaults to ${MAX_DIMENSION}; hard maximum ${MAX_DIMENSION}.`,
              }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("image_pixel_stats", { max_dimension: input.maxDimension }, input.path, context).pipe(
              fail(`Unable to decode pixels of ${input.path}`),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/image-inspect",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, ImageInspectRuntime.node],
})
