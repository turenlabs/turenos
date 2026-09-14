export * as UnicodeAuditTools from "./unicode-audit-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { UnicodeAuditRuntime } from "./unicode-audit-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_FINDINGS = 4096
const MAX_CONTEXT_BYTES = 128
const MAX_LABEL_CHARS = 64
const MAX_TLD_CHARS = 253

const tld = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_TLD_CHARS))
  .pipe(Schema.optional)
  .annotate({
    description:
      "Optional lower-case ASCII DNS top-level label that may influence the encoding guess, mirroring the chardetng API.",
  })

const encodingLabel = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_LABEL_CHARS))
  .pipe(Schema.optional)
  .annotate({ description: "WHATWG encoding label (for example utf-8, windows-1252, utf-16) or auto to guess." })

const FilePath = Schema.NonEmptyString.annotate({ description: "Local text file to analyze." })
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* UnicodeAuditRuntime.Service

    const report = Effect.fn("UnicodeAuditTools.report")(function* (
      op: UnicodeAuditRuntime.Request["op"],
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
        text_detect: Tool.make({
          deferred: true,
          description:
            "Detect the likely WHATWG encoding of a local file — BOM sniffing first, then chardetng statistical detection — reporting the guessed label, confidence, UTF-8 validity, BOM-less UTF-16 heuristics, null-byte ratio, and trial-decode error counts. Bounded and offline.",
          input: Schema.Struct({
            path: FilePath,
            tld,
            iso2022jp: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Whether ISO-2022-JP is a permissible guess. Defaults to true.",
            }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "text_detect",
              { tld: input.tld, iso2022jp: input.iso2022jp },
              input.path,
              context,
            ).pipe(fail(`Unable to detect the encoding of ${input.path}`)),
        }),
        text_stats: Tool.make({
          deferred: true,
          description:
            "Report line, codepoint, and cleanliness statistics for a local text file: encoding, BOM, line count and longest line, control/nonprintable character counts, replacement characters, and a Unicode script histogram over alphabetic characters. Bounded and offline.",
          input: Schema.Struct({
            path: FilePath,
            encoding: encodingLabel.annotate({
              description: "Decode with this WHATWG encoding label instead of guessing. Omit for auto-detection.",
            }),
            tld,
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report("text_stats", { encoding: input.encoding, tld: input.tld }, input.path, context).pipe(
              fail(`Unable to summarize ${input.path}`),
            ),
        }),
        text_transcode: Tool.make({
          deferred: true,
          description:
            "Decode a local file from a known or detected charset to bounded UTF-8 text with WHATWG encoding_rs semantics — BOM-aware, lossy — plus optional Unicode normalization (NFC/NFD/NFKC/NFKD). Reports decode error counts and truncation inside a JSON report carrying the transcoded text.",
          input: Schema.Struct({
            path: FilePath,
            from: encodingLabel.annotate({
              description: "WHATWG encoding label of the source, or auto to guess via chardetng. Defaults to auto.",
            }),
            normalize: Schema.Literals(["nfc", "nfd", "nfkc", "nfkd"])
              .pipe(Schema.optional)
              .annotate({ description: "Optional Unicode normalization form applied to the decoded text." }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "text_transcode",
              { from: input.from, normalize: input.normalize },
              input.path,
              context,
            ).pipe(fail(`Unable to transcode ${input.path}`)),
        }),
        unicode_audit: Tool.make({
          deferred: true,
          description:
            "Audit a local text file for Unicode security issues: Trojan-Source bidi controls and reorder spans, invisible/zero-width and tag characters, unusual whitespace, stray control characters, and mixed-script identifiers that signal homoglyph spoofing. Decodes as lossy UTF-8 and reports findings with offset, line, column, codepoint, and context plus an overall risk level.",
          input: Schema.Struct({
            path: FilePath,
            maxFindings: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_FINDINGS))
              .pipe(Schema.optional)
              .annotate({
                description: `Maximum findings returned. Defaults to ${MAX_FINDINGS}; hard maximum ${MAX_FINDINGS}.`,
              }),
            contextBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_CONTEXT_BYTES))
              .pipe(Schema.optional)
              .annotate({
                description: `Bytes of decoded text quoted around each finding. Defaults to 40; hard maximum ${MAX_CONTEXT_BYTES}.`,
              }),
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            report(
              "unicode_audit",
              { max_findings: input.maxFindings, context_bytes: input.contextBytes },
              input.path,
              context,
            ).pipe(fail(`Unable to audit ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/unicode-audit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, UnicodeAuditRuntime.node],
})
