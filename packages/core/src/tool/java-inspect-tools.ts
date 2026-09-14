export * as JavaInspectTools from "./java-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { JavaInspectRuntime } from "./java-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ENTRIES = 4096
const MAX_ZIP_ENTRIES = 65536
const MAX_NAME = 256

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* JavaInspectRuntime.Service

    const run = Effect.fn("JavaInspectTools.run")(function* (request: JavaInspectRuntime.Request, path: string) {
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
        class_inspect: Tool.make({
          deferred: true,
          description:
            "Parse one Java .class file: version and JDK release name, kind, access flags, this/super class, interfaces, constant-pool summary (optional bounded dump), fields, methods with Code metrics, class attributes, bootstrap methods, and security findings (reflection, Unsafe, ClassLoader.defineClass, Runtime.exec/ProcessBuilder, serialization, native methods, script engines). Parse only — the class is never loaded, linked, verified, or executed.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: ".class file to inspect." }),
            dumpConstantPool: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Include a bounded constant-pool dump (up to 4096 rows, values truncated). Defaults to false.",
            }),
            maxEntries: boundedInt(
              MAX_ENTRIES,
              `Maximum rows per reported list (fields, methods, constant-pool dump, findings). Defaults to ${MAX_ENTRIES}; hard maximum ${MAX_ENTRIES}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "class_inspect", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "class_inspect",
                  bytes: file.bytes,
                  options: { dump_constant_pool: input.dumpConstantPool, max_entries: input.maxEntries },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        class_disassemble: Tool.make({
          deferred: true,
          description:
            "Produce a javap-style bytecode listing for a Java .class file — every method, one methodIndex, or all overloads of a methodName. Constant-pool operands resolve as inline comments; unknown opcodes and truncated operands render explicit WARNING lines. Read-only — bytecode is never executed.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: ".class file to disassemble." }),
            methodIndex: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_ENTRIES))
              .pipe(Schema.optional)
              .annotate({ description: "Zero-based index of one method to list." }),
            methodName: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_NAME))
              .pipe(Schema.optional)
              .annotate({ description: "Select all overloads of this exact method name." }),
            maxMethods: boundedInt(
              MAX_ENTRIES,
              `Maximum methods listed. Defaults to ${MAX_ENTRIES}; hard maximum ${MAX_ENTRIES}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "class_disassemble", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "class_disassemble",
                  bytes: file.bytes,
                  options: {
                    method_index: input.methodIndex,
                    method_name: input.methodName,
                    max_methods: input.maxMethods,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to disassemble ${input.path}`)),
        }),
        jar_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect a JAR (ZIP) file: bounded entry table, decoded META-INF/MANIFEST.MF, signing files (.SF/.RSA/.DSA/.EC), class entry count, multi-release flag, and module-info presence. entryIndex decompresses exactly one entry (32 MiB cap) and embeds its class_inspect report. Listing plus bounded single-entry reads only — nothing is extracted to disk.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "JAR file to inspect." }),
            maxEntries: boundedInt(
              MAX_ENTRIES,
              `Maximum entries reported. Defaults to ${MAX_ENTRIES}; hard maximum ${MAX_ENTRIES}.`,
            ),
            entryIndex: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_ZIP_ENTRIES))
              .pipe(Schema.optional)
              .annotate({
                description: `Zero-based index of one entry to decompress and inspect inline. Hard maximum ${MAX_ZIP_ENTRIES}.`,
              }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "jar_inspect", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "jar_inspect",
                  bytes: file.bytes,
                  options: { max_entries: input.maxEntries, entry_index: input.entryIndex },
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
  name: "tool/java-inspect",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, JavaInspectRuntime.node],
})
