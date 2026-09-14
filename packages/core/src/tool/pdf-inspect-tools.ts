export * as PdfInspectTools from "./pdf-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { PdfInspectRuntime } from "./pdf-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_RESULTS = 4096
const MAX_URLS = 256
const MAX_STREAM_DECODE_BYTES = 8 * 1024 * 1024
const MAX_TEXT_CHARS = 524288

const capped = (cap: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(cap)).pipe(Schema.optional).annotate({ description })

const generation = NonNegativeInt.pipe(Schema.optional).annotate({
  description: "PDF object generation number. Defaults to 0.",
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* PdfInspectRuntime.Service

    const run = Effect.fn("PdfInspectTools.run")(function* (request: PdfInspectRuntime.Request, path: string) {
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
        pdf_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one local PDF file: version, page/object counts, encryption and linearization flags, xref type, catalog keys, /Info metadata, URLs, input SHA-256, and a findings array flagging suspicious constructs (/JavaScript, /OpenAction, /AA, /Launch, /URI actions, /EmbeddedFile, /AcroForm, /XFA, /Names dictionaries, javascript:/data: URIs). Bounded, offline, never executes embedded content.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "PDF file to inspect." }),
            maxFindings: capped(MAX_RESULTS, `Maximum findings returned. Hard maximum ${MAX_RESULTS}.`),
            maxUrls: capped(MAX_URLS, `Maximum URLs collected from string objects. Hard maximum ${MAX_URLS}.`),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "pdf_inspect", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "pdf_inspect",
                  bytes: file.bytes,
                  options: { max_findings: input.maxFindings, max_urls: input.maxUrls },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        pdf_objects: Tool.make({
          deferred: true,
          description:
            "List the bounded object table of one local PDF file: object id/generation, kind, /Type, /Subtype, stream flag and encoded length, declared filters, dictionary keys, and suspicious keys per object. Optionally select one object or filter by /Type or kind. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "PDF file to inspect." }),
            objectId: PositiveInt.pipe(Schema.optional).annotate({
              description: "Select a single object by id (requires generation when nonzero).",
            }),
            generation,
            type: Schema.NonEmptyString.pipe(Schema.optional).annotate({
              description: "Filter objects by /Type name, case-insensitive (for example Font, Page, Annot).",
            }),
            kind: Schema.NonEmptyString.pipe(Schema.optional).annotate({
              description: "Filter objects by variant kind (for example stream, dictionary, array).",
            }),
            maxResults: capped(MAX_RESULTS, `Maximum objects returned. Hard maximum ${MAX_RESULTS}.`),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "pdf_objects", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "pdf_objects",
                  bytes: file.bytes,
                  options: {
                    object_id: input.objectId,
                    generation: input.generation,
                    type: input.type,
                    kind: input.kind,
                    max_results: input.maxResults,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to list objects in ${input.path}`)),
        }),
        pdf_stream_decode: Tool.make({
          deferred: true,
          description:
            "Decode one stream object inside a local PDF file and return the decoded bytes as base64 inside the report, with filters, encoded/decoded lengths, decoded SHA-256, and truncation flags. Supports FlateDecode, ASCIIHexDecode, ASCII85Decode, LZWDecode, RunLengthDecode, and BrotliDecode chains; unsupported filters fail closed. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "PDF file containing the stream." }),
            objectId: PositiveInt.annotate({ description: "Object id of the stream to decode." }),
            generation,
            maxOutputBytes: capped(
              MAX_STREAM_DECODE_BYTES,
              `Maximum decoded bytes accepted before the op fails closed. Hard maximum ${MAX_STREAM_DECODE_BYTES}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "pdf_stream_decode", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "pdf_stream_decode",
                  bytes: file.bytes,
                  options: {
                    object_id: input.objectId,
                    generation: input.generation,
                    max_output_bytes: input.maxOutputBytes,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to decode stream ${input.objectId} in ${input.path}`)),
        }),
        pdf_text: Tool.make({
          deferred: true,
          description:
            "Extract bounded text from the page tree of one local PDF file via bounded content decoding: text, page count, pages processed, character count, per-page warnings, and truncation flag. Bounded, offline, never renders or executes content.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "PDF file to extract text from." }),
            startPage: PositiveInt.pipe(Schema.optional).annotate({
              description: "1-based page to start extraction from. Defaults to 1.",
            }),
            maxPages: capped(MAX_RESULTS, `Maximum pages processed. Hard maximum ${MAX_RESULTS}.`),
            maxChars: capped(
              MAX_TEXT_CHARS,
              `Maximum text characters returned. Hard maximum ${MAX_TEXT_CHARS}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "pdf_text", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "pdf_text",
                  bytes: file.bytes,
                  options: {
                    start_page: input.startPage,
                    max_pages: input.maxPages,
                    max_chars: input.maxChars,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to extract text from ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/pdf-inspect",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, PdfInspectRuntime.node],
})
