export * as YaraTool from "./yara"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { YaraRuntime } from "./yara-runtime"

export const name = "yara_scan"
export const MAX_RULE_SOURCE_LENGTH = 64 * 1024
export const DEFAULT_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 5_000
export const DEFAULT_MATCHES_PER_PATTERN = 32
export const MAX_MATCHES_PER_PATTERN = 256
export const DEFAULT_MATCHED_RULES = 128
export const MAX_MATCHED_RULES = 256

const RuleSource = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(MAX_RULE_SOURCE_LENGTH)))

export const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({
    description: "File to scan. Relative paths resolve from the active Location.",
  }),
  rules: RuleSource.annotate({ description: "YARA-X rule source to compile and apply to the file." }),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Hard YARA scan timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; maximum ${MAX_TIMEOUT_MS}.`,
    }),
  maxMatchesPerPattern: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_MATCHES_PER_PATTERN))
    .pipe(Schema.optional)
    .annotate({
      description: `Maximum offsets returned per pattern. Defaults to ${DEFAULT_MATCHES_PER_PATTERN}; maximum ${MAX_MATCHES_PER_PATTERN}.`,
    }),
  maxRules: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_MATCHED_RULES))
    .pipe(Schema.optional)
    .annotate({
      description: `Maximum matched rules returned. Defaults to ${DEFAULT_MATCHED_RULES}; maximum ${MAX_MATCHED_RULES}.`,
    }),
})

const PatternMatch = Schema.Struct({ offset: NonNegativeInt, length: NonNegativeInt })
const Pattern = Schema.Struct({
  identifier: Schema.String,
  kind: Schema.String,
  isPrivate: Schema.Boolean,
  matches: Schema.Array(PatternMatch),
})
const Metadata = Schema.Struct({
  identifier: Schema.String,
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
})
const Match = Schema.Struct({
  identifier: Schema.String,
  namespace: Schema.String,
  isPrivate: Schema.Boolean,
  isGlobal: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  metadata: Schema.Array(Metadata),
  patterns: Schema.Array(Pattern),
})
export const Output = Schema.Struct({
  path: Schema.String,
  matches: Schema.Array(Match),
  warnings: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})
type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const yara = yield* YaraRuntime.Service

    yield* tools
      .register({
        [name]: Tool.make({
          deferred: true,
          description:
            "Compile YARA-X rules and scan one local file with the bundled WebAssembly runtime. This is bounded static analysis: the target is never executed, no host YARA installation is required, file access is permission-checked, and scan time plus returned matches are capped.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: modelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, name, context, mutation, fs, permission)
              const result = yield* yara
                .scan({
                  bytes: file.bytes,
                  rules: input.rules,
                  timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                  maxMatchesPerPattern: input.maxMatchesPerPattern ?? DEFAULT_MATCHES_PER_PATTERN,
                  maxRules: input.maxRules ?? DEFAULT_MATCHED_RULES,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to scan ${input.path}: ${error.message}` }),
                  ),
                )
              return { path: file.resource, ...result }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to scan ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/yara-scan",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, YaraRuntime.node],
})

function modelOutput(output: Output) {
  if (output.matches.length === 0)
    return `${output.path}: no YARA-X matches${output.warnings.length === 0 ? "" : `\nWarnings:\n${output.warnings.join("\n")}`}`
  return [
    `${output.path}: ${output.matches.length} YARA-X match${output.matches.length === 1 ? "" : "es"}${output.truncated ? " (truncated)" : ""}`,
    ...output.matches.map((match) => {
      const tags = match.tags.length === 0 ? "" : ` [${match.tags.join(", ")}]`
      const patterns = match.patterns
        .flatMap((pattern) =>
          pattern.matches.map((item) => `${pattern.identifier}@0x${item.offset.toString(16)}+${item.length}`),
        )
        .join(", ")
      return `${match.namespace}:${match.identifier}${tags}${patterns ? `\n  ${patterns}` : ""}`
    }),
    ...(output.warnings.length === 0 ? [] : ["Warnings:", ...output.warnings]),
  ].join("\n")
}
