export * as SqliteInspectTools from "./sqlite-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { SqliteInspectRuntime } from "./sqlite-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096
const MAX_ROWS = 256
const MAX_BLOB_PREVIEW = 256
const MAX_CANDIDATES = 4096
const MAX_MIN_COLUMNS = 64

const boundedInt = (max: number, description: string) =>
  PositiveInt.check(Schema.isLessThanOrEqualTo(max)).pipe(Schema.optional).annotate({ description })

const maxItems = boundedInt(
  MAX_ITEMS,
  `Maximum reported list entries. Defaults to ${MAX_ITEMS}; hard maximum ${MAX_ITEMS}.`,
)

const tableName = (description: string) =>
  Schema.NonEmptyString.check(Schema.isMaxLength(256)).annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* SqliteInspectRuntime.Service

    const run = Effect.fn("SqliteInspectTools.run")(function* (
      request: SqliteInspectRuntime.Request,
      path: string,
    ) {
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
        sqlite_inspect: Tool.make({
          deferred: true,
          description:
            "Decode the 100-byte header of one SQLite 3 database file: magic check, page size, journal mode (WAL vs rollback), payload fractions, change counter, in-header db size, freelist summary, schema cookie/format, autovacuum, text encoding, user version, application id, and validity flags. Read-only forensics — the file is never modified and WAL contents are never replayed.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SQLite database file to inspect." }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "sqlite_inspect", context, mutation, fs, permission)
              const report = yield* run({ op: "sqlite_inspect", bytes: file.bytes, options: {} }, input.path)
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to inspect ${input.path}`)),
        }),
        sqlite_schema: Tool.make({
          deferred: true,
          description:
            "Walk the sqlite_master b-tree of one SQLite 3 database file and emit every schema record: type, name, tblName, rootpage, and the CREATE statement (bounded to 8 KiB). Read-only; never executes SQL.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SQLite database file whose schema to dump." }),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "sqlite_schema", context, mutation, fs, permission)
              const report = yield* run(
                { op: "sqlite_schema", bytes: file.bytes, options: { maxItems: input.maxItems } },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to dump schema of ${input.path}`)),
        }),
        sqlite_table_stats: Tool.make({
          deferred: true,
          description:
            "Walk per-table b-trees in one SQLite 3 database file: page counts by type (interior/leaf/overflow), row count, depth, min/max rowid, cells with overflow, fragmented free bytes, and corruption findings. Optionally limits the walk to one named table. Read-only; never executes SQL.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SQLite database file to analyze." }),
            table: tableName("Optional table name; limits the b-tree walk to one table.").pipe(Schema.optional),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "sqlite_table_stats", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "sqlite_table_stats",
                  bytes: file.bytes,
                  options: { table: input.table, maxItems: input.maxItems },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to analyze ${input.path}`)),
        }),
        sqlite_rows: Tool.make({
          deferred: true,
          description:
            "Decode rows of one named table's root b-tree in a SQLite 3 database file, in key order: rowid, page, typed values (null/integer/real/text/blob with bounded previews and SHA-256 — blob bodies are never inlined), overflow page counts, and best-effort column names. WITHOUT ROWID tables decode PK-first. Read-only; reflects last checkpointed state under WAL.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SQLite database file to read rows from." }),
            table: tableName("Table whose root b-tree to decode."),
            maxRows: boundedInt(
              MAX_ROWS,
              `Maximum rows decoded. Defaults to 64; hard maximum ${MAX_ROWS}.`,
            ),
            blobPreviewBytes: boundedInt(
              MAX_BLOB_PREVIEW,
              `Hex preview bytes per blob value. Defaults to 32; hard maximum ${MAX_BLOB_PREVIEW}.`,
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "sqlite_rows", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "sqlite_rows",
                  bytes: file.bytes,
                  options: {
                    table: input.table,
                    maxRows: input.maxRows,
                    blobPreviewBytes: input.blobPreviewBytes,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to read rows from ${input.path}`)),
        }),
        sqlite_freelist: Tool.make({
          deferred: true,
          description:
            "Walk the freelist trunk-page chain of one SQLite 3 database file: each trunk's next pointer and leaf-page list, declared vs counted free pages, broken links and cycles, and carving statistics (bytes available on free pages). Read-only; never modifies the file.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SQLite database file whose freelist to walk." }),
            maxItems,
            includeLeaves: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Emit per-trunk leaf page lists. Defaults to true.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "sqlite_freelist", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "sqlite_freelist",
                  bytes: file.bytes,
                  options: { maxItems: input.maxItems, includeLeaves: input.includeLeaves },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to walk freelist of ${input.path}`)),
        }),
        sqlite_carve: Tool.make({
          deferred: true,
          description:
            "Heuristically scan unallocated gaps, freeblock bodies, and freelist pages of one SQLite 3 database file for record-shaped data — the forensic path for deleted rows. Results are heuristic candidates, not confirmed records: confidence is a scoring hint and partially overwritten rows may surface only as partial candidates.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "SQLite database file to carve records from." }),
            maxCandidates: boundedInt(
              MAX_CANDIDATES,
              `Maximum candidates reported. Defaults to 256; hard maximum ${MAX_CANDIDATES}.`,
            ),
            minColumns: boundedInt(
              MAX_MIN_COLUMNS,
              `Minimum column count a record-shaped candidate must have. Defaults to 2; range 1-${MAX_MIN_COLUMNS}.`,
            ),
            includeValues: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Decode candidate values inline. Defaults to true.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "sqlite_carve", context, mutation, fs, permission)
              const report = yield* run(
                {
                  op: "sqlite_carve",
                  bytes: file.bytes,
                  options: {
                    maxCandidates: input.maxCandidates,
                    minColumns: input.minColumns,
                    includeValues: input.includeValues,
                  },
                },
                input.path,
              )
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(fail(`Unable to carve ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/sqlite-inspect",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, SqliteInspectRuntime.node],
})
