export * as MinidumpTools from "./minidump-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { MinidumpRuntime } from "./minidump-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_LIMIT = 4096
const MAX_MEMORY_READ = 65536
const MAX_PREVIEW_BYTES = 65536

const limit = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LIMIT))
  .pipe(Schema.optional)
  .annotate({ description: `Maximum list items returned. Defaults to ${MAX_LIMIT}; hard maximum ${MAX_LIMIT}.` })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* MinidumpRuntime.Service

    const run = Effect.fn("MinidumpTools.run")(function* (request: MinidumpRuntime.Request, path: string) {
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
        minidump_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect one local Windows minidump or Breakpad/Crashpad crash dump: header, stream directory, system info, exception record with crash reason and registers, threads, modules, memory regions, misc info, and Crashpad annotations. Bounded, offline, parse-only.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Minidump (.dmp/MDMP) file to inspect." }),
            limit,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "minidump_inspect", context, mutation, fs, permission)
              const report = yield* run(
                { op: "minidump_inspect", bytes: file.bytes, options: { limit: input.limit } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        minidump_modules: Tool.make({
          deferred: true,
          description:
            "List the modules in one local minidump: name, code file, base address, size, version, checksum, timestamp, code_id, and CodeView/PDB debug identifiers (pdb70/pdb20/elf) for matching against debug-symbols output. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Minidump file to read modules from." }),
            limit,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "minidump_modules", context, mutation, fs, permission)
              const report = yield* run(
                { op: "minidump_modules", bytes: file.bytes, options: { limit: input.limit } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to list modules in ${input.path}`)),
        }),
        minidump_stream: Tool.make({
          deferred: true,
          description:
            "Decode one selected stream inside a local minidump. Typed streams (thread/module/memory lists, exception, system info, misc info, Breakpad/Crashpad and Linux streams) decode to structured JSON; streams without a typed decoder return a bounded base64 preview. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Minidump file to read the stream from." }),
            stream: Schema.Union([NonNegativeInt, Schema.NonEmptyString])
              .pipe(Schema.optional)
              .annotate({
                description:
                  "Stream selector: numeric stream type, hex string such as 0x4, or stream name such as ModuleListStream.",
              }),
            name: Schema.NonEmptyString.pipe(Schema.optional).annotate({
              description: "Named stream selector, for example SystemInfoStream. Alternative to stream.",
            }),
            previewBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_PREVIEW_BYTES))
              .pipe(Schema.optional)
              .annotate({
                description: `Maximum preview bytes for undecoded streams. Defaults to ${MAX_PREVIEW_BYTES}; hard maximum ${MAX_PREVIEW_BYTES}.`,
              }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "minidump_stream", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "minidump_stream",
                  bytes: file.bytes,
                  options: { stream: input.stream, name: input.name, previewBytes: input.previewBytes },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to decode a stream in ${input.path}`)),
        }),
        minidump_memory_read: Tool.make({
          deferred: true,
          description:
            "Read a bounded virtual address range from one local minidump through its memory regions (Memory64List preferred, then MemoryList). Returns base64 bytes, the serving region, and full/partial coverage; unmapped addresses fail. Bounded, offline.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "Minidump file to read memory from." }),
            address: NonNegativeInt.annotate({
              description: "Virtual address to start reading from, as a decimal integer.",
            }),
            length: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_MEMORY_READ)).annotate({
              description: `Number of bytes to read. Hard maximum ${MAX_MEMORY_READ}.`,
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "minidump_memory_read", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "minidump_memory_read",
                  bytes: file.bytes,
                  options: { address: input.address, length: input.length },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to read memory in ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/minidump",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, MinidumpRuntime.node],
})
