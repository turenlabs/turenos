import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { optional } from "../schema"
import { MemoryIndex } from "./fts"
import { MemoryKey } from "./key"
import { MemorySchema } from "./schema"
import { MemoryTokenize } from "./tokenize"
import { MemoryDrawerTable, MemoryRoomTable, MemoryWingTable } from "./sql"
import type { ProjectSchema } from "../project/schema"

const PAGE_LIMIT = MemorySchema.MAX_SEARCH_LIMIT

export const WingID = MemorySchema.WingID
export type WingID = MemorySchema.WingID

export const RoomID = MemorySchema.RoomID
export type RoomID = MemorySchema.RoomID

export const DrawerID = MemorySchema.DrawerID
export type DrawerID = MemorySchema.DrawerID

export const Wing = MemorySchema.Wing
export type Wing = MemorySchema.Wing

export const Room = MemorySchema.Room
export type Room = MemorySchema.Room

export const Drawer = MemorySchema.Drawer
export type Drawer = MemorySchema.Drawer

export const Anchor = MemorySchema.Anchor
export type Anchor = MemorySchema.Anchor

export const Provenance = MemorySchema.Provenance
export type Provenance = MemorySchema.Provenance

export const Result = MemorySchema.Result
export type Result = MemorySchema.Result

export const WingInput = Schema.Struct({
  kind: MemorySchema.WingKind,
  key: Schema.String,
  name: Schema.String,
  projectID: Schema.String.pipe(optional),
}).annotate({ identifier: "Memory.WingInput" })
export type WingInput = typeof WingInput.Type

export const RoomInput = Schema.Struct({
  wingID: MemorySchema.WingID,
  slug: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "Memory.RoomInput" })
export type RoomInput = typeof RoomInput.Type

export const WriteInput = Schema.Struct({
  wingID: MemorySchema.WingID,
  roomID: MemorySchema.RoomID,
  kind: MemorySchema.DrawerKind.pipe(optional),
  title: Schema.String,
  body: Schema.String,
  anchor: MemorySchema.Anchor.pipe(optional),
  provenance: MemorySchema.Provenance,
  validFrom: Schema.Number.pipe(optional),
  /** Closes the named drawer's validity window at `validFrom` and links it forward. */
  supersedes: MemorySchema.DrawerID.pipe(optional),
}).annotate({ identifier: "Memory.WriteInput" })
export type WriteInput = typeof WriteInput.Type

/**
 * Every read names the wings it may see. There is no unscoped variant and an
 * empty list returns nothing rather than everything — the failure mode of a
 * caller that forgot to pass a scope has to be "no memories", never "all of
 * someone else's memories".
 */
export const SearchInput = Schema.Struct({
  query: Schema.String,
  wings: Schema.Array(MemorySchema.WingID),
  rooms: Schema.Array(MemorySchema.RoomID).pipe(optional),
  limit: Schema.Number.pipe(optional),
  /** Point in time to answer as of. Defaults to now. */
  asOf: Schema.Number.pipe(optional),
  includeExpired: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Memory.SearchInput" })
export type SearchInput = typeof SearchInput.Type

export const ReadInput = Schema.Struct({
  id: MemorySchema.DrawerID,
  wings: Schema.Array(MemorySchema.WingID),
}).annotate({ identifier: "Memory.ReadInput" })
export type ReadInput = typeof ReadInput.Type

export const ListInput = Schema.Struct({
  wings: Schema.Array(MemorySchema.WingID),
  rooms: Schema.Array(MemorySchema.RoomID).pipe(optional),
  limit: Schema.Number.pipe(optional),
  offset: Schema.Number.pipe(optional),
}).annotate({ identifier: "Memory.ListInput" })
export type ListInput = typeof ListInput.Type

export const UpdateInput = Schema.Struct({
  id: MemorySchema.DrawerID,
  expectedTimeUpdated: Schema.Number,
  wingID: MemorySchema.WingID,
  roomID: MemorySchema.RoomID,
  kind: MemorySchema.DrawerKind,
  title: Schema.String,
  body: Schema.String,
  anchor: MemorySchema.Anchor.pipe(optional),
}).annotate({ identifier: "Memory.UpdateInput" })
export type UpdateInput = typeof UpdateInput.Type

export class InvalidRoomError extends Schema.TaggedErrorClass<InvalidRoomError>()("Memory.InvalidRoomError", {
  wingID: MemorySchema.WingID,
  roomID: MemorySchema.RoomID,
}) {}

export interface Interface {
  /** Upsert a wing by (kind, key). Idempotent. */
  readonly wing: (input: WingInput) => Effect.Effect<Wing>
  readonly wings: () => Effect.Effect<ReadonlyArray<Wing>>
  /** Upsert a room by (wing, slug). Idempotent. */
  readonly room: (input: RoomInput) => Effect.Effect<Room>
  readonly rooms: (wingID: WingID) => Effect.Effect<ReadonlyArray<Room>>
  readonly write: (input: WriteInput) => Effect.Effect<Drawer, InvalidRoomError>
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<Drawer>>
  readonly update: (input: UpdateInput) => Effect.Effect<Drawer | undefined>
  readonly read: (input: ReadInput) => Effect.Effect<Drawer | undefined>
  readonly search: (input: SearchInput) => Effect.Effect<ReadonlyArray<Result>>
  readonly forget: (input: ReadInput) => Effect.Effect<boolean>
  /**
   * Rebuild the lexical index from the drawers. Drawer bodies are stored
   * verbatim and drawer ids are stable, so this is also the seam a non-lexical
   * backend would be built through: everything an embedding index needs is
   * recoverable from `memory_drawer` alone, without re-reading any transcript.
   */
  readonly reindex: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Memory") {}

type DrawerRow = {
  id: string
  wing_id: string
  room_id: string
  kind: string
  title: string
  body: string
  anchor_repo: string | null
  anchor_path: string | null
  anchor_commit: string | null
  anchor_symbol: string | null
  asserted_by: string
  source: string
  session_id: string | null
  time_valid_from: number
  time_valid_until: number | null
  superseded_by: string | null
  time_created: number
  time_updated: number
}

function toDrawer(row: DrawerRow): Drawer {
  const anchor: Record<string, string> = {}
  if (row.anchor_repo) anchor["repo"] = row.anchor_repo
  if (row.anchor_path) anchor["path"] = row.anchor_path
  if (row.anchor_commit) anchor["commit"] = row.anchor_commit
  if (row.anchor_symbol) anchor["symbol"] = row.anchor_symbol
  return {
    id: row.id as DrawerID,
    wingID: row.wing_id as WingID,
    roomID: row.room_id as RoomID,
    kind: row.kind as MemorySchema.DrawerKind,
    title: row.title,
    body: row.body,
    anchor,
    provenance: {
      assertedBy: row.asserted_by,
      source: row.source as MemorySchema.Source,
      ...(row.session_id ? { sessionID: row.session_id } : {}),
      ...(row.anchor_commit ? { commit: row.anchor_commit } : {}),
    },
    timeValidFrom: row.time_valid_from,
    ...(row.time_valid_until === null ? {} : { timeValidUntil: row.time_valid_until }),
    ...(row.superseded_by ? { supersededBy: row.superseded_by as DrawerID } : {}),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

const DRAWER_COLUMNS = sql.raw(
  [
    "id",
    "wing_id",
    "room_id",
    "kind",
    "title",
    "body",
    "anchor_repo",
    "anchor_path",
    "anchor_commit",
    "anchor_symbol",
    "asserted_by",
    "source",
    "session_id",
    "time_valid_from",
    "time_valid_until",
    "superseded_by",
    "time_created",
    "time_updated",
  ]
    .map((column) => `d.${column} AS ${column}`)
    .join(", "),
)

const FTS = sql.identifier(MemoryIndex.TABLE)

/**
 * The next value of a drawer's `time_updated`, which doubles as its
 * optimistic-concurrency token.
 *
 * A wall-clock millisecond is not a version. Two mutations of the same drawer
 * landing inside one millisecond leave `time_updated` on the value the *first*
 * of them started from, so a caller still holding that pre-update value passes
 * the compare-and-set and silently overwrites an edit it never saw — the exact
 * lost update the token exists to prevent. Taking `max(now, time_updated + 1)`
 * makes the column strictly increasing per row, which is what a CAS token has
 * to be, without changing its type or the wire contract (`expectedTimeUpdated`
 * is a number the client echoes back).
 *
 * It remains a timestamp: it can only run ahead of the wall clock by the number
 * of updates that shared a millisecond, and only until the clock catches up.
 */
const nextTimeUpdated = (now: number) => sql`max(${now}, ${sql.identifier("time_updated")} + 1)`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const primary = Database.primary(db)
    // The index is not part of the drizzle migration pipeline; see ./fts.ts for
    // why. Creating it here means a fresh database and an upgraded one take the
    // exact same code path.
    yield* MemoryIndex.ensure(primary).pipe(Effect.orDie)

    const wing = Effect.fn("Memory.wing")(function* (input: WingInput) {
      const row = yield* primary
        .insert(MemoryWingTable)
        .values({
          id: MemorySchema.WingID.create(),
          kind: input.kind,
          key: input.key,
          name: input.name,
          project_id: input.projectID as ProjectSchema.ID | undefined,
        })
        .onConflictDoUpdate({
          target: [MemoryWingTable.kind, MemoryWingTable.key],
          set: { name: input.name, time_updated: Date.now() },
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      return {
        id: row!.id,
        kind: row!.kind,
        key: row!.key,
        name: row!.name,
        timeCreated: row!.time_created,
        timeUpdated: row!.time_updated,
      }
    })

    const wings = Effect.fn("Memory.wings")(function* () {
      const rows = yield* db.select().from(MemoryWingTable).all().pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        key: row.key,
        name: row.name,
        timeCreated: row.time_created,
        timeUpdated: row.time_updated,
      }))
    })

    const room = Effect.fn("Memory.room")(function* (input: RoomInput) {
      const row = yield* primary
        .insert(MemoryRoomTable)
        .values({
          id: MemorySchema.RoomID.create(),
          wing_id: input.wingID,
          slug: input.slug,
          name: input.name,
        })
        .onConflictDoUpdate({
          target: [MemoryRoomTable.wing_id, MemoryRoomTable.slug],
          set: { name: input.name, time_updated: Date.now() },
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      return {
        id: row!.id,
        wingID: row!.wing_id,
        slug: row!.slug,
        name: row!.name,
        timeCreated: row!.time_created,
        timeUpdated: row!.time_updated,
      }
    })

    const rooms = Effect.fn("Memory.rooms")(function* (wingID: WingID) {
      const rows = yield* db
        .select()
        .from(MemoryRoomTable)
        .where(eq(MemoryRoomTable.wing_id, wingID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        wingID: row.wing_id,
        slug: row.slug,
        name: row.name,
        timeCreated: row.time_created,
        timeUpdated: row.time_updated,
      }))
    })

    const write = Effect.fn("Memory.write")(function* (input: WriteInput) {
      const id = MemorySchema.DrawerID.create()
      const now = Date.now()
      const validFrom = input.validFrom ?? now
      const anchor = input.anchor ?? {}
      const row = yield* primary
        .transaction((tx) =>
          Effect.gen(function* () {
            const room = yield* tx
              .select({ id: MemoryRoomTable.id })
              .from(MemoryRoomTable)
              .where(and(eq(MemoryRoomTable.id, input.roomID), eq(MemoryRoomTable.wing_id, input.wingID)))
              .get()
              .pipe(Effect.orDie)
            if (!room) return yield* new InvalidRoomError({ wingID: input.wingID, roomID: input.roomID })
            const inserted = yield* tx
              .insert(MemoryDrawerTable)
              .values({
                id,
                wing_id: input.wingID,
                room_id: input.roomID,
                kind: input.kind ?? "note",
                title: input.title,
                // Verbatim. Summarising on write throws away the only copy.
                body: input.body,
                anchor_repo: anchor.repo ?? null,
                anchor_path: anchor.path ?? null,
                anchor_commit: anchor.commit ?? input.provenance.commit ?? null,
                anchor_symbol: anchor.symbol ?? null,
                asserted_by: input.provenance.assertedBy,
                source: input.provenance.source,
                session_id: input.provenance.sessionID ?? null,
                time_valid_from: validFrom,
                time_created: now,
                time_updated: now,
              })
              .returning()
              .get()
              .pipe(Effect.orDie)
            yield* indexDrawer(tx, {
              id,
              wingID: input.wingID,
              title: input.title,
              body: input.body,
              anchor,
            }).pipe(Effect.orDie)
            if (input.supersedes) {
              // Scoped to the same wing: superseding across the ACL boundary
              // would be a write into someone else's memory.
              yield* tx
                .update(MemoryDrawerTable)
                .set({ time_valid_until: validFrom, superseded_by: id, time_updated: nextTimeUpdated(now) })
                .where(
                  and(
                    eq(MemoryDrawerTable.id, input.supersedes),
                    eq(MemoryDrawerTable.wing_id, input.wingID),
                    isNull(MemoryDrawerTable.time_valid_until),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
            }
            return inserted
          }),
        )
        .pipe(Effect.catch((error) => (error instanceof InvalidRoomError ? Effect.fail(error) : Effect.die(error))))
      return toDrawer(row as unknown as DrawerRow)
    })

    const read = Effect.fn("Memory.read")(function* (input: ReadInput) {
      if (input.wings.length === 0) return undefined
      const row = yield* db
        .select()
        .from(MemoryDrawerTable)
        .where(and(eq(MemoryDrawerTable.id, input.id), inArray(MemoryDrawerTable.wing_id, [...input.wings])))
        .get()
        .pipe(Effect.orDie)
      return row ? toDrawer(row as unknown as DrawerRow) : undefined
    })

    const list = Effect.fn("Memory.list")(function* (input: ListInput) {
      if (input.wings.length === 0) return []
      const requestedLimit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : PAGE_LIMIT
      const requestedOffset = typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : 0
      const limit = Math.max(1, Math.min(Math.floor(requestedLimit), MemorySchema.MAX_SEARCH_LIMIT))
      const offset = Math.max(0, Math.floor(requestedOffset))
      const rows = yield* db
        .select()
        .from(MemoryDrawerTable)
        .where(
          and(
            inArray(MemoryDrawerTable.wing_id, [...input.wings]),
            input.rooms && input.rooms.length > 0 ? inArray(MemoryDrawerTable.room_id, [...input.rooms]) : undefined,
          ),
        )
        .orderBy(desc(MemoryDrawerTable.time_updated), desc(MemoryDrawerTable.id))
        .limit(limit)
        .offset(offset)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => toDrawer(row as unknown as DrawerRow))
    })

    const update = Effect.fn("Memory.update")(function* (input: UpdateInput) {
      const anchor = input.anchor
      const now = Date.now()
      const row = yield* primary
        .transaction((tx) =>
          Effect.gen(function* () {
            const room = yield* tx
              .select({ id: MemoryRoomTable.id })
              .from(MemoryRoomTable)
              .where(and(eq(MemoryRoomTable.id, input.roomID), eq(MemoryRoomTable.wing_id, input.wingID)))
              .get()
              .pipe(Effect.orDie)
            if (!room) return undefined
            const current = yield* tx
              .select({
                anchor_repo: MemoryDrawerTable.anchor_repo,
                anchor_path: MemoryDrawerTable.anchor_path,
                anchor_commit: MemoryDrawerTable.anchor_commit,
                anchor_symbol: MemoryDrawerTable.anchor_symbol,
              })
              .from(MemoryDrawerTable)
              .where(
                and(
                  eq(MemoryDrawerTable.id, input.id),
                  eq(MemoryDrawerTable.wing_id, input.wingID),
                  eq(MemoryDrawerTable.time_updated, input.expectedTimeUpdated),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!current) return undefined
            const updated = yield* tx
              .update(MemoryDrawerTable)
              .set({
                room_id: input.roomID,
                kind: input.kind,
                title: input.title,
                body: input.body,
                anchor_repo: anchor?.repo ?? current.anchor_repo,
                anchor_path: anchor ? (anchor.path ?? null) : current.anchor_path,
                anchor_commit: anchor?.commit ?? current.anchor_commit,
                anchor_symbol: anchor ? (anchor.symbol ?? null) : current.anchor_symbol,
                time_updated: nextTimeUpdated(now),
              })
              .where(
                and(
                  eq(MemoryDrawerTable.id, input.id),
                  eq(MemoryDrawerTable.wing_id, input.wingID),
                  eq(MemoryDrawerTable.time_updated, input.expectedTimeUpdated),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!updated) return undefined
            yield* tx.run(sql`DELETE FROM ${FTS} WHERE drawer_id = ${input.id}`).pipe(Effect.orDie)
            yield* indexDrawer(tx, {
              id: input.id,
              wingID: input.wingID,
              title: input.title,
              body: input.body,
              anchor: {
                ...(updated.anchor_repo ? { repo: updated.anchor_repo } : {}),
                ...(updated.anchor_path ? { path: updated.anchor_path } : {}),
                ...(updated.anchor_commit ? { commit: updated.anchor_commit } : {}),
                ...(updated.anchor_symbol ? { symbol: updated.anchor_symbol } : {}),
              },
            }).pipe(Effect.orDie)
            return updated
          }),
        )
        .pipe(Effect.orDie)
      return row ? toDrawer(row as unknown as DrawerRow) : undefined
    })

    const search = Effect.fn("Memory.search")(function* (input: SearchInput) {
      if (input.wings.length === 0) return []
      // Prune first, build the expression second: `MemoryTokenize.expression`
      // re-checks every survivor, so nothing that skipped `assertTerm` can
      // reach MATCH regardless of what pruning did.
      const terms = MemoryTokenize.searchTerms(input.query)
      const asOf = input.asOf ?? Date.now()
      const match = MemoryTokenize.expression(
        yield* MemoryIndex.prune(db, terms, input.wings, {
          rooms: input.rooms,
          asOf,
          includeExpired: input.includeExpired,
        }).pipe(Effect.orDie),
      )
      if (!match) return []
      const limit = Math.max(
        1,
        Math.min(Math.floor(input.limit ?? MemorySchema.DEFAULT_SEARCH_LIMIT), MemorySchema.MAX_SEARCH_LIMIT),
      )
      const wingList = sql.join(
        input.wings.map((id) => sql`${id}`),
        sql`, `,
      )
      const roomFilter =
        input.rooms && input.rooms.length > 0
          ? sql` AND d.room_id IN (${sql.join(
              input.rooms.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      // Validity is filtered inside the ranked query, not after it, so an
      // expired fact cannot occupy one of the `limit` slots.
      const temporalFilter = input.includeExpired
        ? sql``
        : sql` AND d.time_valid_from <= ${asOf} AND (d.time_valid_until IS NULL OR d.time_valid_until > ${asOf})`
      const rows = yield* db
        .all<DrawerRow & { score: number }>(
          sql`SELECT ${DRAWER_COLUMNS}, bm25(${FTS}) AS score
              FROM ${FTS}
              JOIN ${MemoryDrawerTable} AS d ON d.id = ${FTS}.drawer_id
              WHERE ${FTS} MATCH ${match}
                AND ${FTS}.wing_id IN (${wingList})${roomFilter}${temporalFilter}
              ORDER BY score
              LIMIT ${limit}`,
        )
        .pipe(Effect.orDie)
      // FTS5 bm25() is negative with lower being better; flip it so callers can
      // treat score as "higher is more relevant" regardless of backend.
      return rows.map((row) => ({ drawer: toDrawer(row), score: -row.score }))
    })

    const forget = Effect.fn("Memory.forget")(function* (input: ReadInput) {
      if (input.wings.length === 0) return false
      return yield* primary
        .transaction((tx) =>
          Effect.gen(function* () {
            const deleted = yield* tx
              .delete(MemoryDrawerTable)
              .where(and(eq(MemoryDrawerTable.id, input.id), inArray(MemoryDrawerTable.wing_id, [...input.wings])))
              .returning({ id: MemoryDrawerTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!deleted) return false
            yield* tx.run(sql`DELETE FROM ${FTS} WHERE drawer_id = ${input.id}`).pipe(Effect.orDie)
            return true
          }),
        )
        .pipe(Effect.orDie)
    })

    const reindex = Effect.fn("Memory.reindex")(function* () {
      return yield* primary
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx.select().from(MemoryDrawerTable).all().pipe(Effect.orDie)
            yield* tx.run(sql`DELETE FROM ${FTS}`).pipe(Effect.orDie)
            for (const row of rows) {
              yield* indexDrawer(tx, {
                id: row.id,
                wingID: row.wing_id,
                title: row.title,
                body: row.body,
                anchor: {
                  ...(row.anchor_repo ? { repo: row.anchor_repo } : {}),
                  ...(row.anchor_path ? { path: row.anchor_path } : {}),
                  ...(row.anchor_commit ? { commit: row.anchor_commit } : {}),
                  ...(row.anchor_symbol ? { symbol: row.anchor_symbol } : {}),
                },
              }).pipe(Effect.orDie)
            }
            return rows.length
          }),
        )
        .pipe(Effect.orDie)
    })

    const indexState = yield* primary
      .all<{ drawers: number; index_rows: number; missing: number }>(
        sql`SELECT
          (SELECT count(*) FROM ${MemoryDrawerTable}) AS drawers,
          (SELECT count(*) FROM ${FTS}) AS index_rows,
          (SELECT count(*) FROM ${MemoryDrawerTable} AS d
            WHERE NOT EXISTS (SELECT 1 FROM ${FTS} AS f WHERE f.drawer_id = d.id)) AS missing`,
      )
      .pipe(Effect.orDie)
    const state = indexState[0]
    if (state && (state.drawers !== state.index_rows || state.missing > 0)) yield* reindex()

    return Service.of({ wing, wings, room, rooms, write, list, update, read, search, forget, reindex })
  }),
)

type Indexable = {
  id: DrawerID
  wingID: WingID
  title: string
  body: string
  anchor: Anchor
}

function indexDrawer(tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0], input: Indexable) {
  return tx.run(
    sql`INSERT INTO ${FTS} (drawer_id, wing_id, title, body, anchor) VALUES (${input.id}, ${input.wingID}, ${MemoryTokenize.normalize(input.title)}, ${MemoryTokenize.normalize(input.body)}, ${MemoryTokenize.normalize(MemoryKey.indexable(input.anchor))})`,
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
