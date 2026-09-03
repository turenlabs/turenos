export * as MemoryIndex from "./fts"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export const TABLE = "memory_drawer_fts"
export const VOCAB = "memory_drawer_fts_vocab"

/**
 * FTS5 lives outside the drizzle-kit migration pipeline, on purpose.
 *
 * `bun run migration` can only emit DDL that drizzle can express, and a virtual
 * table is not that. Worse, `DatabaseMigration.apply` runs `schema.gen.ts` on a
 * fresh database and then *stamps every migration as already applied* — so a
 * hand-written migration creating this table would exist on upgraded installs
 * and silently not exist on new ones. That asymmetry is exactly the class of
 * bug where a fixture passes and production breaks.
 *
 * So the memory module owns its own index: an idempotent `CREATE ... IF NOT
 * EXISTS` run when the Memory layer is built, which is identical on a fresh
 * database and an upgraded one.
 *
 * Column layout mirrors the drawer: `title`, `body` and `anchor` are indexed
 * separately so field weighting stays available later; `drawer_id` and
 * `wing_id` are UNINDEXED because they are filters and identifiers, not text.
 * `tokenchars '_'` keeps `session_runner` addressable as one token — the
 * tokenizer in `./tokenize` has already emitted the split parts alongside it.
 */
const CREATE = `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(
  drawer_id UNINDEXED,
  wing_id UNINDEXED,
  title,
  body,
  anchor,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
)`

/**
 * `fts5vocab` is a read-only view over the index FTS5 already maintains — one
 * row per distinct term, with `doc` being the number of documents containing
 * it. It stores nothing of its own, so this costs no disk and no write path,
 * and it ships inside FTS5 itself, so it adds no dependency.
 */
const CREATE_VOCAB = `CREATE VIRTUAL TABLE IF NOT EXISTS ${VOCAB} USING fts5vocab(${TABLE}, 'row')`

const CREATE_DELETE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS memory_drawer_fts_cleanup_after_delete
  AFTER DELETE ON memory_drawer
  BEGIN
    DELETE FROM ${TABLE} WHERE drawer_id = OLD.id;
  END`

/**
 * Terms in at least this fraction of documents are dropped from the query.
 *
 * The threshold is read off the scoring function rather than tuned on a
 * benchmark. FTS5 computes `IDF = log((N - df + 0.5) / (df + 0.5))` and then
 * clamps it: `if (idf <= 0.0) idf = 1e-6`. That clamp bites at exactly
 * `df >= N/2`, so a term held by half the corpus contributes 1e-6 — nothing —
 * to every document's score, while still forcing FTS5 to walk its entire
 * posting list. Dropping it cannot change the ranking of documents that match
 * something else; it only stops documents whose *sole* evidence is a ubiquitous
 * term from occupying a result slot.
 *
 * Note this is not the same as the reference BM25 in the benchmark, which uses
 * `log(1 + x)` and floors at zero. Neither implementation goes negative, so
 * pruning is a latency and candidate-set change, not an IDF correction — and
 * measurably it does not move conceptual recall at all. See the header of
 * `forge-memory-bench/eval_fts5_prune.ts`.
 */
export const MAX_DOCUMENT_FREQUENCY = 0.5

/**
 * When every term is over the threshold — a query made entirely of words this
 * corpus uses everywhere — keep this many of the rarest rather than returning
 * nothing. Pruning must never turn a query with content into a query without.
 */
export const MIN_KEPT_TERMS = 3

/**
 * Below this many documents, don't prune at all.
 *
 * A document frequency measured over a dozen drawers is not a corpus statistic,
 * and a memory that has just started collecting is exactly where dropping a
 * candidate is least affordable. This keeps early-life retrieval byte-identical
 * to the unpruned path instead of discontinuous.
 */
export const MIN_DOCUMENTS = 200

/** Idempotent. Safe to run on every open and from concurrent processes. */
export function ensure(db: Database | Transaction) {
  return Effect.gen(function* () {
    yield* db.run(sql.raw(CREATE))
    yield* db.run(sql.raw(CREATE_VOCAB))
    yield* db.run(sql.raw(CREATE_DELETE_TRIGGER))
    // Repair indexes created before the cleanup trigger existed, including
    // rows removed by a foreign-key cascade while the process was running.
    yield* db.run(
      sql.raw(
        `DELETE FROM ${TABLE} WHERE NOT EXISTS (SELECT 1 FROM memory_drawer WHERE memory_drawer.id = ${TABLE}.drawer_id)`,
      ),
    )
  })
}

type PruneOptions = {
  readonly rooms?: readonly string[]
  readonly asOf?: number
  readonly includeExpired?: boolean
}

/**
 * Drop query terms that are too common in this corpus to carry any ranking
 * signal. Terms are bound as parameters, never interpolated, and the caller
 * re-checks every survivor through `assertTerm` before it reaches `MATCH`.
 */
export function prune(db: Database, terms: readonly string[], wings: readonly string[], options: PruneOptions = {}) {
  return Effect.gen(function* () {
    if (terms.length <= 1 || wings.length === 0) return [...terms]
    const wingList = sql.join(
      wings.map((wing) => sql`${wing}`),
      sql`, `,
    )
    const roomFilter =
      options.rooms && options.rooms.length > 0
        ? sql` AND d.room_id IN (${sql.join(
            options.rooms.map((room) => sql`${room}`),
            sql`, `,
          )})`
        : sql``
    const asOf = options.asOf ?? Date.now()
    const temporalFilter = options.includeExpired
      ? sql``
      : sql` AND d.time_valid_from <= ${asOf} AND (d.time_valid_until IS NULL OR d.time_valid_until > ${asOf})`
    const fts = sql.identifier(TABLE)
    const corpus = sql`FROM ${fts} JOIN memory_drawer AS d ON d.id = ${fts}.drawer_id`
    // Frequencies must be measured over the same corpus the query will search.
    // The corpus includes the room and temporal filters so an expired or
    // unrelated drawer cannot suppress a term needed by the requested view.
    const totalRows = yield* db.all<{ total: number }>(
      sql`SELECT count(*) AS total ${corpus} WHERE ${fts}.wing_id IN (${wingList})${roomFilter}${temporalFilter}`,
    )
    const total = totalRows[0]?.total ?? 0
    if (total < MIN_DOCUMENTS) return [...terms]
    // One MATCH per term; terms arrive via `searchTerms`, so each has already
    // passed `assertTerm`, and they are bound as parameters regardless.
    const frequency = new Map<string, number>()
    for (const term of terms) {
      const rows = yield* db.all<{ doc: number }>(
        sql`SELECT count(*) AS doc ${corpus}
            WHERE ${fts} MATCH ${`"${term}"`} AND ${fts}.wing_id IN (${wingList})${roomFilter}${temporalFilter}`,
      )
      frequency.set(term, rows[0]?.doc ?? 0)
    }
    const cut = total * MAX_DOCUMENT_FREQUENCY
    const kept = terms.filter((term) => (frequency.get(term) ?? 0) < cut)
    if (kept.length > 0) return kept
    return [...terms].sort((a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0)).slice(0, MIN_KEPT_TERMS)
  })
}
