import { Storage } from "@turenlabs/schema/storage"
import { and, asc, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { DataMigrationTable } from "../data-migration.sql"
import { makeGlobalNode } from "../effect/app-node"
import { StorageStateTable } from "./sql"

export const Scope = Storage.Scope
export type Scope = Storage.Scope

export const Key = Storage.Key
export type Key = Storage.Key

export const Revision = Storage.Revision
export type Revision = Storage.Revision

export const Address = Storage.Address
export type Address = Storage.Address

export const State = Storage.State
export type State = Storage.State

export const ListInput = Storage.ListInput
export type ListInput = Storage.ListInput

export const SetInput = Storage.SetInput
export type SetInput = Storage.SetInput

export const CompareAndSwapInput = Storage.CompareAndSwapInput
export type CompareAndSwapInput = Storage.CompareAndSwapInput

export const RevisionConflict = Storage.RevisionConflict
export type RevisionConflict = Storage.RevisionConflict

export const MigrationReceipt = Storage.MigrationReceipt
export type MigrationReceipt = Storage.MigrationReceipt

export const ImportInput = Storage.ImportInput
export type ImportInput = Storage.ImportInput

export const ImportResult = Storage.ImportResult
export type ImportResult = Storage.ImportResult

export const MigrationConflict = Storage.MigrationConflict
export type MigrationConflict = Storage.MigrationConflict

type DatabaseShape = Database.Interface["db"]
export type Transaction = Parameters<Parameters<DatabaseShape["transaction"]>[0]>[0]
export type RemoveIfRevisionInput = Address & { readonly expectedRevision: Revision }
export type ReplaceInput = Readonly<{
  scope: Scope
  entries: ReadonlyArray<Readonly<{ key: Key; value: string }>>
}>
export type BatchInput = Readonly<{
  sets: ReadonlyArray<SetInput>
  removes: ReadonlyArray<Address>
}>
export type GuardedBatchInput = BatchInput &
  Readonly<{
    guards: ReadonlyArray<Address & { readonly expectedRevision: Revision | null }>
  }>
export type QueryInput = Readonly<{
  scope: Scope
  prefix: string
  limit: number
  order?: "key-asc" | "time-created-desc"
  cursor?: Readonly<{ key: Key; timeCreated: number }>
}>

export interface Interface {
  readonly get: (input: Address) => Effect.Effect<State | undefined>
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<State>>
  readonly query: (input: QueryInput) => Effect.Effect<ReadonlyArray<State>>
  readonly set: (input: SetInput) => Effect.Effect<State>
  readonly remove: (input: Address) => Effect.Effect<boolean>
  readonly removeIfRevision: (input: RemoveIfRevisionInput) => Effect.Effect<boolean, RevisionConflict>
  readonly clear: (scope: Scope) => Effect.Effect<number>
  readonly replace: (input: ReplaceInput) => Effect.Effect<number>
  readonly batch: (input: BatchInput) => Effect.Effect<number>
  readonly guardedBatch: (input: GuardedBatchInput) => Effect.Effect<number, RevisionConflict>
  readonly compareAndSwap: (input: CompareAndSwapInput) => Effect.Effect<State, RevisionConflict>
  readonly migrationReceipt: (name: string) => Effect.Effect<MigrationReceipt | undefined>
  readonly importEntries: (
    input: ImportInput,
    entries: ReadonlyArray<SetInput>,
  ) => Effect.Effect<ImportResult, MigrationConflict>
  readonly importLegacy: <R>(
    input: ImportInput,
    apply: (tx: Transaction) => Effect.Effect<number, never, R>,
  ) => Effect.Effect<ImportResult, MigrationConflict, R>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Storage") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("Storage.get")(function* (input: Address) {
      const row = yield* db
        .select()
        .from(StorageStateTable)
        .where(
          and(
            eq(StorageStateTable.scope, input.scope),
            eq(StorageStateTable.key, input.key),
            eq(StorageStateTable.deleted, false),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? state(row) : undefined
    })

    const list = Effect.fn("Storage.list")(function* (input: ListInput) {
      return (yield* db
        .select()
        .from(StorageStateTable)
        .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.deleted, false)))
        .orderBy(asc(StorageStateTable.key))
        .all()
        .pipe(Effect.orDie)).map(state)
    })

    const query = Effect.fn("Storage.query")(function* (input: QueryInput) {
      const order = input.order ?? "key-asc"
      const cursor = input.cursor
        ? order === "key-asc"
          ? gt(StorageStateTable.key, input.cursor.key)
          : or(
              lt(StorageStateTable.time_created, input.cursor.timeCreated),
              and(
                eq(StorageStateTable.time_created, input.cursor.timeCreated),
                lt(StorageStateTable.key, input.cursor.key),
              ),
            )
        : undefined
      const rows = yield* db
        .select()
        .from(StorageStateTable)
        .where(
          and(
            eq(StorageStateTable.scope, input.scope),
            eq(StorageStateTable.deleted, false),
            sql`${StorageStateTable.key} >= ${input.prefix}`,
            sql`${StorageStateTable.key} < ${`${input.prefix}\uffff`}`,
            cursor,
          ),
        )
        .orderBy(
          order === "key-asc" ? asc(StorageStateTable.key) : desc(StorageStateTable.time_created),
          order === "key-asc" ? asc(StorageStateTable.key) : desc(StorageStateTable.key),
        )
        .limit(Math.max(1, Math.min(1_000, Math.floor(input.limit))))
        .all()
        .pipe(Effect.orDie)
      return rows.map(state)
    })

    const set = Effect.fn("Storage.set")(function* (input: SetInput) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = Date.now()
            const written = yield* tx
              .insert(StorageStateTable)
              .values({
                scope: input.scope,
                key: input.key,
                value: input.value,
                revision: 1,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [StorageStateTable.scope, StorageStateTable.key],
                set: {
                  value: input.value,
                  revision: sql`${StorageStateTable.revision} + 1`,
                  deleted: false,
                  time_updated: now,
                },
                setWhere: or(eq(StorageStateTable.deleted, true), ne(StorageStateTable.value, input.value)),
              })
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (written) return state(written)

            const current = yield* tx
              .select()
              .from(StorageStateTable)
              .where(
                and(
                  eq(StorageStateTable.scope, input.scope),
                  eq(StorageStateTable.key, input.key),
                  eq(StorageStateTable.deleted, false),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (current) return state(current)
            return yield* Effect.die(`Storage set lost ${input.scope}/${input.key} after its write transaction`)
          }),
        )
        .pipe(Effect.orDie)
    })

    const remove = Effect.fn("Storage.remove")(function* (input: Address) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select({ revision: StorageStateTable.revision })
              .from(StorageStateTable)
              .where(
                and(
                  eq(StorageStateTable.scope, input.scope),
                  eq(StorageStateTable.key, input.key),
                  eq(StorageStateTable.deleted, false),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!current) return false
            yield* tx
              .update(StorageStateTable)
              .set({ value: "", revision: current.revision + 1, deleted: true, time_updated: Date.now() })
              .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, input.key)))
              .run()
              .pipe(Effect.orDie)
            return true
          }),
        )
        .pipe(Effect.orDie)
    })

    const removeIfRevision = Effect.fn("Storage.removeIfRevision")(function* (input: RemoveIfRevisionInput) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select({ revision: StorageStateTable.revision, deleted: StorageStateTable.deleted })
              .from(StorageStateTable)
              .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, input.key)))
              .get()
              .pipe(Effect.orDie)
            if (!current || current.deleted || current.revision !== input.expectedRevision) {
              return yield* new RevisionConflict({
                scope: input.scope,
                key: input.key,
                expected: input.expectedRevision,
                actual: current && !current.deleted ? current.revision : null,
              })
            }
            const removed = yield* tx
              .update(StorageStateTable)
              .set({
                value: "",
                revision: current.revision + 1,
                deleted: true,
                time_updated: Date.now(),
              })
              .where(
                and(
                  eq(StorageStateTable.scope, input.scope),
                  eq(StorageStateTable.key, input.key),
                  eq(StorageStateTable.revision, input.expectedRevision),
                  eq(StorageStateTable.deleted, false),
                ),
              )
              .returning({ revision: StorageStateTable.revision })
              .get()
              .pipe(Effect.orDie)
            if (removed) return true
            const raced = yield* tx
              .select({ revision: StorageStateTable.revision, deleted: StorageStateTable.deleted })
              .from(StorageStateTable)
              .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, input.key)))
              .get()
              .pipe(Effect.orDie)
            return yield* new RevisionConflict({
              scope: input.scope,
              key: input.key,
              expected: input.expectedRevision,
              actual: raced && !raced.deleted ? raced.revision : null,
            })
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const clear = Effect.fn("Storage.clear")(function* (scope: Scope) {
      return yield* db
        .transaction((tx) =>
          tx
            .update(StorageStateTable)
            .set({
              value: "",
              revision: sql`${StorageStateTable.revision} + 1`,
              deleted: true,
              time_updated: Date.now(),
            })
            .where(and(eq(StorageStateTable.scope, scope), eq(StorageStateTable.deleted, false)))
            .returning({ key: StorageStateTable.key })
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((removed) => removed.length),
            ),
        )
        .pipe(Effect.orDie)
    })

    const replace = Effect.fn("Storage.replace")(function* (input: ReplaceInput) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = Date.now()
            const current = yield* tx
              .select()
              .from(StorageStateTable)
              .where(eq(StorageStateTable.scope, input.scope))
              .all()
              .pipe(Effect.orDie)
            const desired = new Map(input.entries.map((entry) => [entry.key, entry]))
            yield* Effect.forEach(
              current.filter((row) => !row.deleted && !desired.has(row.key)),
              (row) =>
                tx
                  .update(StorageStateTable)
                  .set({ value: "", revision: row.revision + 1, deleted: true, time_updated: now })
                  .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, row.key)))
                  .run()
                  .pipe(Effect.orDie),
              { concurrency: 1, discard: true },
            )
            const previous = new Map(current.map((row) => [row.key, row]))
            yield* Effect.forEach(
              input.entries,
              (entry) => {
                const row = previous.get(entry.key)
                if (row && !row.deleted && row.value === entry.value) return Effect.void
                if (row) {
                  return tx
                    .update(StorageStateTable)
                    .set({ value: entry.value, revision: row.revision + 1, deleted: false, time_updated: now })
                    .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, entry.key)))
                    .run()
                    .pipe(Effect.orDie)
                }
                return tx
                  .insert(StorageStateTable)
                  .values({
                    scope: input.scope,
                    key: entry.key,
                    value: entry.value,
                    revision: 1,
                    time_created: now,
                    time_updated: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
              },
              { concurrency: 1, discard: true },
            )
            return input.entries.length
          }),
        )
        .pipe(Effect.orDie)
    })

    const batch = Effect.fn("Storage.batch")(function* (input: BatchInput) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = Date.now()
            const sets = yield* Effect.forEach(
              input.sets,
              (entry) =>
                tx
                  .insert(StorageStateTable)
                  .values({
                    scope: entry.scope,
                    key: entry.key,
                    value: entry.value,
                    revision: 1,
                    time_created: now,
                    time_updated: now,
                  })
                  .onConflictDoUpdate({
                    target: [StorageStateTable.scope, StorageStateTable.key],
                    set: {
                      value: entry.value,
                      revision: sql`${StorageStateTable.revision} + 1`,
                      deleted: false,
                      time_updated: now,
                    },
                    setWhere: or(eq(StorageStateTable.deleted, true), ne(StorageStateTable.value, entry.value)),
                  })
                  .returning({ key: StorageStateTable.key })
                  .get()
                  .pipe(Effect.orDie),
              { concurrency: 1 },
            )
            const removes = yield* Effect.forEach(
              input.removes,
              (entry) =>
                tx
                  .update(StorageStateTable)
                  .set({
                    value: "",
                    revision: sql`${StorageStateTable.revision} + 1`,
                    deleted: true,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(StorageStateTable.scope, entry.scope),
                      eq(StorageStateTable.key, entry.key),
                      eq(StorageStateTable.deleted, false),
                    ),
                  )
                  .returning({ key: StorageStateTable.key })
                  .get()
                  .pipe(Effect.orDie),
              { concurrency: 1 },
            )
            return sets.filter(Boolean).length + removes.filter(Boolean).length
          }),
        )
        .pipe(Effect.orDie)
    })

    const guardedBatch = Effect.fn("Storage.guardedBatch")(function* (input: GuardedBatchInput) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              for (const guard of input.guards) {
                const current = yield* tx
                  .select({ revision: StorageStateTable.revision, deleted: StorageStateTable.deleted })
                  .from(StorageStateTable)
                  .where(and(eq(StorageStateTable.scope, guard.scope), eq(StorageStateTable.key, guard.key)))
                  .get()
                  .pipe(Effect.orDie)
                const actual = current && !current.deleted ? current.revision : null
                if (actual === guard.expectedRevision) continue
                return yield* new RevisionConflict({
                  scope: guard.scope,
                  key: guard.key,
                  expected: guard.expectedRevision,
                  actual,
                })
              }

              const now = Date.now()
              const sets = yield* Effect.forEach(
                input.sets,
                (entry) =>
                  tx
                    .insert(StorageStateTable)
                    .values({
                      scope: entry.scope,
                      key: entry.key,
                      value: entry.value,
                      revision: 1,
                      time_created: now,
                      time_updated: now,
                    })
                    .onConflictDoUpdate({
                      target: [StorageStateTable.scope, StorageStateTable.key],
                      set: {
                        value: entry.value,
                        revision: sql`${StorageStateTable.revision} + 1`,
                        deleted: false,
                        time_updated: now,
                      },
                      setWhere: or(eq(StorageStateTable.deleted, true), ne(StorageStateTable.value, entry.value)),
                    })
                    .returning({ key: StorageStateTable.key })
                    .get()
                    .pipe(Effect.orDie),
                { concurrency: 1 },
              )
              const removes = yield* Effect.forEach(
                input.removes,
                (entry) =>
                  tx
                    .update(StorageStateTable)
                    .set({
                      value: "",
                      revision: sql`${StorageStateTable.revision} + 1`,
                      deleted: true,
                      time_updated: now,
                    })
                    .where(
                      and(
                        eq(StorageStateTable.scope, entry.scope),
                        eq(StorageStateTable.key, entry.key),
                        eq(StorageStateTable.deleted, false),
                      ),
                    )
                    .returning({ key: StorageStateTable.key })
                    .get()
                    .pipe(Effect.orDie),
                { concurrency: 1 },
              )
              return sets.filter(Boolean).length + removes.filter(Boolean).length
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const compareAndSwap = Effect.fn("Storage.compareAndSwap")(function* (input: CompareAndSwapInput) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(StorageStateTable)
              .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, input.key)))
              .get()
              .pipe(Effect.orDie)
            const actual = current && !current.deleted ? current.revision : null
            if (actual !== input.expectedRevision) {
              return yield* new RevisionConflict({
                scope: input.scope,
                key: input.key,
                expected: input.expectedRevision,
                actual,
              })
            }
            if (current && !current.deleted && current.value === input.value) return state(current)

            const now = Date.now()
            if (!current) {
              const created = {
                scope: input.scope,
                key: input.key,
                value: input.value,
                revision: 1,
                time_created: now,
                time_updated: now,
              }
              const inserted = yield* tx
                .insert(StorageStateTable)
                .values(created)
                .onConflictDoNothing()
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (inserted) return state(inserted)
              const raced = yield* tx
                .select({ revision: StorageStateTable.revision, deleted: StorageStateTable.deleted })
                .from(StorageStateTable)
                .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, input.key)))
                .get()
                .pipe(Effect.orDie)
              return yield* new RevisionConflict({
                scope: input.scope,
                key: input.key,
                expected: input.expectedRevision,
                actual: raced && !raced.deleted ? raced.revision : null,
              })
            }

            if (current.deleted) {
              const reactivated = yield* tx
                .update(StorageStateTable)
                .set({ value: input.value, revision: current.revision + 1, deleted: false, time_updated: now })
                .where(
                  and(
                    eq(StorageStateTable.scope, input.scope),
                    eq(StorageStateTable.key, input.key),
                    eq(StorageStateTable.revision, current.revision),
                    eq(StorageStateTable.deleted, true),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (reactivated) return state(reactivated)
              return yield* new RevisionConflict({
                scope: input.scope,
                key: input.key,
                expected: input.expectedRevision,
                actual: null,
              })
            }

            const updated = yield* tx
              .update(StorageStateTable)
              .set({ value: input.value, revision: current.revision + 1, time_updated: now })
              .where(
                and(
                  eq(StorageStateTable.scope, input.scope),
                  eq(StorageStateTable.key, input.key),
                  eq(StorageStateTable.revision, current.revision),
                  eq(StorageStateTable.deleted, false),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (updated) return state(updated)
            const raced = yield* tx
              .select({ revision: StorageStateTable.revision, deleted: StorageStateTable.deleted })
              .from(StorageStateTable)
              .where(and(eq(StorageStateTable.scope, input.scope), eq(StorageStateTable.key, input.key)))
              .get()
              .pipe(Effect.orDie)
            return yield* new RevisionConflict({
              scope: input.scope,
              key: input.key,
              expected: input.expectedRevision,
              actual: raced && !raced.deleted ? raced.revision : null,
            })
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const migrationReceipt = Effect.fn("Storage.migrationReceipt")(function* (name: string) {
      const row = yield* db
        .select()
        .from(DataMigrationTable)
        .where(eq(DataMigrationTable.name, name))
        .get()
        .pipe(Effect.orDie)
      return row ? receipt(row) : undefined
    })

    const importLegacy: Interface["importLegacy"] = Effect.fn("Storage.importLegacy")(function* (input, apply) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(DataMigrationTable)
              .where(eq(DataMigrationTable.name, input.name))
              .get()
              .pipe(Effect.orDie)
            if (current) {
              const stored = receipt(current)
              if (
                stored.sourceFingerprint === input.sourceFingerprint &&
                stored.sourceVersion === input.sourceVersion
              ) {
                return ImportResult.make({ applied: false, receipt: stored })
              }
              return yield* new MigrationConflict({
                name: input.name,
                recordedFingerprint: stored.sourceFingerprint,
                recordedVersion: stored.sourceVersion,
                attemptedFingerprint: input.sourceFingerprint,
                attemptedVersion: input.sourceVersion,
              })
            }

            const rowCount = yield* apply(tx)
            const now = Date.now()
            const stored = MigrationReceipt.make({
              name: input.name,
              sourceFingerprint: input.sourceFingerprint,
              sourceVersion: input.sourceVersion,
              rowCount,
              timeCompleted: now,
              timeVerified: now,
            })
            yield* tx
              .insert(DataMigrationTable)
              .values({
                name: stored.name,
                source_fingerprint: stored.sourceFingerprint,
                source_version: stored.sourceVersion,
                row_count: stored.rowCount,
                time_completed: stored.timeCompleted,
                time_verified: stored.timeVerified,
              })
              .run()
              .pipe(Effect.orDie)
            return ImportResult.make({ applied: true, receipt: stored })
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const importEntries = Effect.fn("Storage.importEntries")(function* (
      input: ImportInput,
      entries: ReadonlyArray<SetInput>,
    ) {
      return yield* importLegacy(input, (tx) => {
        const now = Date.now()
        return Effect.forEach(
          entries,
          (entry) =>
            tx
              .insert(StorageStateTable)
              .values({
                scope: entry.scope,
                key: entry.key,
                value: entry.value,
                revision: 1,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .returning({ key: StorageStateTable.key })
              .get()
              .pipe(Effect.orDie),
          { concurrency: 1 },
        ).pipe(Effect.map((inserted) => inserted.filter(Boolean).length))
      })
    })

    return Service.of({
      get,
      list,
      query,
      set,
      remove,
      removeIfRevision,
      clear,
      replace,
      batch,
      guardedBatch,
      compareAndSwap,
      migrationReceipt,
      importEntries,
      importLegacy,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

function state(row: typeof StorageStateTable.$inferSelect): State {
  return State.make({
    scope: row.scope,
    key: row.key,
    value: row.value,
    revision: row.revision,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  })
}

function receipt(row: typeof DataMigrationTable.$inferSelect): MigrationReceipt {
  return MigrationReceipt.make({
    name: row.name,
    sourceFingerprint: row.source_fingerprint,
    sourceVersion: row.source_version,
    rowCount: row.row_count,
    timeCompleted: row.time_completed,
    timeVerified: row.time_verified,
  })
}
