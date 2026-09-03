import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"
import type { MemorySchema } from "./schema"
import type { ProjectSchema } from "../project/schema"
import { ProjectTable } from "../project/sql"

/**
 * Wings — the ACL boundary. A wing is a person, a project, or an engagement.
 *
 * Every drawer carries its `wing_id` denormalised so that authorisation is a
 * predicate on the row being read rather than a join that a future query can
 * forget to write. `Memory.search` takes the caller's wings as a required
 * argument and there is no unscoped read path.
 */
export const MemoryWingTable = sqliteTable(
  "memory_wing",
  {
    id: text().$type<MemorySchema.WingID>().primaryKey(),
    kind: text().$type<MemorySchema.WingKind>().notNull(),
    /**
     * Stable identity for whatever the wing represents, and opaque here: nothing
     * may parse a directory back out of it. A `project` wing backed by git keys
     * on the TurenOS project id (from the git remote, else the root commit), which
     * is machine-portable — the same repo has a different absolute path on every
     * machine that clones it. A directory with no repository has no portable
     * identity to borrow, so it gets a machine-local `local:` key seeded once
     * from its path and then pinned in storage against the directory's
     * filesystem identity; the path seeds that key and never re-derives it,
     * because a rename would otherwise fork the wing and strand its drawers.
     */
    key: text().notNull(),
    name: text().notNull(),
    /**
     * Convenience link for project wings. Nullable because person and
     * engagement wings outlive any single repo.
     */
    project_id: text()
      .$type<ProjectSchema.ID>()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    ...Timestamps,
  },
  (table) => [uniqueIndex("memory_wing_kind_key_idx").on(table.kind, table.key)],
)

/** Rooms — topics within a wing. */
export const MemoryRoomTable = sqliteTable(
  "memory_room",
  {
    id: text().$type<MemorySchema.RoomID>().primaryKey(),
    wing_id: text()
      .$type<MemorySchema.WingID>()
      .notNull()
      .references(() => MemoryWingTable.id, { onDelete: "cascade" }),
    slug: text().notNull(),
    name: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("memory_room_wing_slug_idx").on(table.wing_id, table.slug)],
)

/** Drawers — verbatim content. Nothing here is summarised on write. */
export const MemoryDrawerTable = sqliteTable(
  "memory_drawer",
  {
    id: text().$type<MemorySchema.DrawerID>().primaryKey(),
    wing_id: text()
      .$type<MemorySchema.WingID>()
      .notNull()
      .references(() => MemoryWingTable.id, { onDelete: "cascade" }),
    room_id: text()
      .$type<MemorySchema.RoomID>()
      .notNull()
      .references(() => MemoryRoomTable.id, { onDelete: "cascade" }),
    kind: text().$type<MemorySchema.DrawerKind>().notNull(),
    title: text().notNull(),
    body: text().notNull(),

    // --- machine-portable key -------------------------------------------
    // Repo-relative and commit-pinned. There is deliberately no absolute path
    // column: 46% of remembered paths already do not exist on the disk that
    // remembered them, and a peer's absolute path means nothing here.
    anchor_repo: text(),
    anchor_path: DatabasePath.pathColumn(),
    anchor_commit: text(),
    anchor_symbol: text(),

    // --- provenance -------------------------------------------------------
    // A shared memory is a claim, not a fact, so who/where/when travels with it.
    asserted_by: text().notNull(),
    source: text().$type<MemorySchema.Source>().notNull(),
    // Intentionally not a foreign key. Memory has to outlive the session that
    // produced it; a cascade from `session` would delete the record of the claim
    // along with the conversation.
    session_id: text(),

    // --- temporal validity ------------------------------------------------
    // Facts change. Superseding writes a new drawer and closes the old one's
    // window rather than overwriting it, so history stays answerable.
    time_valid_from: integer().notNull(),
    time_valid_until: integer(),
    superseded_by: text()
      .$type<MemorySchema.DrawerID>()
      .references((): AnySQLiteColumn => MemoryDrawerTable.id, { onDelete: "set null" }),
    ...Timestamps,
  },
  (table) => [
    index("memory_drawer_wing_valid_idx").on(table.wing_id, table.time_valid_until),
    index("memory_drawer_room_idx").on(table.room_id, table.time_created),
    index("memory_drawer_anchor_idx").on(table.wing_id, table.anchor_repo, table.anchor_path),
    index("memory_drawer_session_idx").on(table.session_id),
  ],
)
