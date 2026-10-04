export * as ScriptDeobfuscateTools from "./script-deobfuscate-tools"

import { createHash } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolOutputStore } from "../tool-output-store"
import { read } from "./binary-file"
import { ScriptDeobfuscateRuntime } from "./script-deobfuscate-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const runtime = yield* ScriptDeobfuscateRuntime.Service
    yield* tools
      .register({
        script_deobfuscate: Tool.make({
          deferred: true,
          description:
            "Statically recover readable JavaScript from a local file using bounded, offline Rust/WASM analysis. Never executes submitted code. Writes readable code and optional recovered execution-sink payload evidence to managed artifacts; reports original UTF-8 byte spans, warnings and explicit assumptions. Unsupported expressions remain intact; no claim of complete deobfuscation. Input limit 1 MiB.",
          input: Schema.Struct({
            language: Schema.Literal("js").pipe(Schema.optional),
            path: Schema.NonEmptyString,
            extractPayloads: Schema.Boolean.pipe(Schema.optional),
            assumeStandardBuiltins: Schema.Boolean.pipe(Schema.optional).annotate({
              description:
                "Allow supported intrinsic decoding under an explicit pristine standard-builtins assumption. Known shadowing/reassignment still blocks rewrites. Defaults to false.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(
                input.path,
                "script_deobfuscate",
                context,
                mutation,
                fs,
                permission,
                1024 * 1024,
                true,
              )
              const result = yield* runtime.run({
                bytes: file.bytes,
                options: {
                  language: input.language ?? "js",
                  extractPayloads: input.extractPayloads ?? false,
                  assumeStandardBuiltins: input.assumeStandardBuiltins ?? false,
                },
              })
              const code = new TextEncoder().encode(result.code)
              const artifactPath = yield* artifacts.writeBytes(code)
              const payloads = yield* Effect.forEach(result.payloads, (payload) =>
                Effect.gen(function* () {
                  const bytes = new TextEncoder().encode(payload.code)
                  return {
                    kind: payload.kind,
                    start: payload.start,
                    end: payload.end,
                    sha256: payload.sha256,
                    bytes: bytes.length,
                    artifactPath: yield* artifacts.writeBytes(bytes),
                  }
                }),
              )
              return {
                path: file.resource,
                report: JSON.stringify(
                  {
                    schema_version: result.schema_version,
                    language: result.language,
                    path: file.resource,
                    input: result.input,
                    code: {
                      artifactPath,
                      bytes: code.length,
                      sha256: createHash("sha256").update(code).digest("hex"),
                      preview: preview(result.code),
                      previewTruncated: code.length > 4096,
                    },
                    transformations: result.transformations,
                    payloads,
                    assumptions: input.assumeStandardBuiltins
                      ? [
                          "Supported intrinsic decoding assumes pristine standard builtins; known shadowing/reassignment blocks rewrites.",
                        ]
                      : [],
                    warnings: result.warnings,
                    truncated: result.truncated,
                    notice:
                      "Static recovery only. Recovered payloads are evidence, not confirmed execution; unsupported expressions may remain.",
                  },
                  null,
                  2,
                ),
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: `Unable to deobfuscate ${input.path}: ${error instanceof Error ? error.message : String(error)}`,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({
  name: "tool/script-deobfuscate",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    ToolOutputStore.node,
    ScriptDeobfuscateRuntime.node,
  ],
})

function preview(code: string) {
  if (Buffer.byteLength(code) <= 4096) return code
  // Avoid introducing a replacement character by splitting a UTF-8 sequence.
  const bytes = new TextEncoder().encode(code)
  const end =
    bytes[4096] >= 0x80 && bytes[4096] < 0xc0
      ? ([4095, 4094, 4093].find((index) => bytes[index] < 0x80 || bytes[index] >= 0xc0) ?? 4093)
      : 4096
  return new TextDecoder().decode(bytes.subarray(0, end))
}
