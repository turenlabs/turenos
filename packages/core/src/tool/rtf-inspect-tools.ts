export * as RtfInspectTools from "./rtf-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { RtfInspectRuntime } from "./rtf-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096
const MAX_HISTOGRAM_ROWS = 256
const MAX_TEXT_CHARS = 512 * 1024

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* RtfInspectRuntime.Service

    const run = Effect.fn("RtfInspectTools.run")(function* (request: RtfInspectRuntime.Request, path: string) {
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

    const inspect = Effect.fn("RtfInspectTools.inspect")(function* (
      op: RtfInspectRuntime.Request["op"],
      input: { readonly path: string },
      context: Tool.Context,
      options: Readonly<Record<string, unknown>>,
    ) {
      const file = yield* read(input.path, op, context, mutation, fs, permission)
      const report = yield* run({ op, bytes: file.bytes, options }, input.path)
      return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
    })

    yield* tools
      .register({
        rtf_inspect: Tool.make({
          deferred: true,
          description:
            "Report the structure of one local RTF document: group tree stats (depth, balance, trailing bytes), top control-word histogram, font/style/color tables, {\\*\\generator} producer, {\\info} metadata, picture and OLE-object summaries, {\\*\\datastore}, {\\*\\filetbl} entries, field instructions, and a body-text preview. Bounded, offline, never executes embedded content; payloads are reported as hashes and previews only.",
          input: Schema.Struct({
            path: FilePath("RTF document to inspect."),
            top: boundedInt(
              MAX_HISTOGRAM_ROWS,
              `Control-word histogram rows returned. Defaults to 32; hard maximum ${MAX_HISTOGRAM_ROWS}.`,
            ),
            maxResults: boundedInt(
              MAX_ITEMS,
              `Maximum items per reported list (fonts, styles, colors, objects, files, fields). Defaults to 1024; hard maximum ${MAX_ITEMS}.`,
            ),
            previewChars: boundedInt(
              MAX_ITEMS,
              `Body-text preview characters returned. Defaults to 512; hard maximum ${MAX_ITEMS}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("rtf_inspect", input, context, {
              top: input.top,
              max_results: input.maxResults,
              preview_chars: input.previewChars,
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        rtf_objects: Tool.make({
          deferred: true,
          description:
            "Enumerate embedded OLE objects in one local RTF document: {\\object} groups with objclass names, declared dimensions, decoded \\objdata byte counts, SHA-256 digests, 16-byte hex previews, OLE compound-file (d0cf11e0) detection, and malformed-hex detail. Never executes embedded content; payloads are reported as hashes and previews only.",
          input: Schema.Struct({
            path: FilePath("RTF document to enumerate embedded objects from."),
            maxResults: boundedInt(
              MAX_ITEMS,
              `Maximum objects returned. Defaults to 1024; hard maximum ${MAX_ITEMS}.`,
            ),
            includePayloadHex: Schema.Boolean.pipe(Schema.optional).annotate({
              description:
                "Inline the full decoded \\objdata payload hex when the payload is at most 64 KiB. Defaults to false; payloads are otherwise reported as SHA-256 plus a 16-byte preview.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("rtf_objects", input, context, {
              max_results: input.maxResults,
              include_payload_hex: input.includePayloadHex,
            }).pipe(fail(`Unable to enumerate objects in ${input.path}`)),
        }),
        rtf_audit: Tool.make({
          deferred: true,
          description:
            "Audit one local RTF document for exploit-document indicators as {kind, offset, detail, severity} findings: objdata payloads, OLE compound objects, suspicious objclass names, file tables and embedded files, remote template paths, external field references (HYPERLINK/INCLUDETEXT), password protection, obfuscated or fragmented control words, hex-heavy regions, deep nesting, unbalanced braces, trailing data, mixed encodings, and malformed hex. Read-only; never executes embedded content.",
          input: Schema.Struct({
            path: FilePath("RTF document to audit."),
            maxFindings: boundedInt(
              MAX_ITEMS,
              `Maximum findings returned. Defaults to ${MAX_ITEMS}; hard maximum ${MAX_ITEMS}.`,
            ),
            minSeverity: Schema.Literals(["info", "low", "medium", "high"])
              .pipe(Schema.optional)
              .annotate({ description: 'Minimum finding severity reported. Defaults to "info".' }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("rtf_audit", input, context, {
              max_findings: input.maxFindings,
              min_severity: input.minSeverity,
            }).pipe(fail(`Unable to audit ${input.path}`)),
        }),
        rtf_text: Tool.make({
          deferred: true,
          description:
            "Extract bounded plain text from one local RTF document: control words stripped, \\'hh hex escapes resolved through the document code page, \\uN Unicode skipped-fallback resolved, and non-body destinations (font/color/style tables, info, pictures, objects, fields, ignorable groups) skipped. Read-only; never executes embedded content.",
          input: Schema.Struct({
            path: FilePath("RTF document to extract text from."),
            maxChars: boundedInt(
              MAX_TEXT_CHARS,
              `Maximum extracted characters. Defaults to 262144; hard maximum ${MAX_TEXT_CHARS}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("rtf_text", input, context, { max_chars: input.maxChars }).pipe(
              fail(`Unable to extract text from ${input.path}`),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/rtf-inspect",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, RtfInspectRuntime.node],
})
