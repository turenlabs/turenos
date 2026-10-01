import { PriorWork } from "@turenlabs/schema/prior-work"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ProjectSchema } from "../project/schema"
import { ProjectTable } from "../project/sql"
import type { SessionSchema } from "../session/schema"

/**
 * A repository binding: the filesystem incarnation of a canonical Git common directory. The path
 * only locates a binding; device, inode, and birth time identify it, so a replacement at the same
 * path does not inherit and a rename or alias does.
 */
export const PriorWorkRepositoryTable = sqliteTable(
  "prior_work_repository",
  {
    id: text().$type<PriorWork.RepositoryID>().primaryKey(),
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    dev: integer().notNull(),
    ino: integer().notNull(),
    birthtime: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("prior_work_repository_incarnation_idx").on(table.project_id, table.dev, table.ino, table.birthtime),
  ],
)

/** One-directional, non-transitive owner grant: `repository_id` may read `target_repository_id`. */
export const PriorWorkLinkTable = sqliteTable(
  "prior_work_link",
  {
    repository_id: text()
      .$type<PriorWork.RepositoryID>()
      .notNull()
      .references(() => PriorWorkRepositoryTable.id, { onDelete: "cascade" }),
    target_repository_id: text()
      .$type<PriorWork.RepositoryID>()
      .notNull()
      .references(() => PriorWorkRepositoryTable.id, { onDelete: "cascade" }),
    time_created: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.repository_id, table.target_repository_id] })],
)

export const PriorWorkRecordTable = sqliteTable(
  "prior_work_record",
  {
    id: text().$type<PriorWork.RecordID>().primaryKey(),
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    repository_id: text()
      .$type<PriorWork.RepositoryID>()
      .notNull()
      .references(() => PriorWorkRepositoryTable.id, { onDelete: "cascade" }),
    kind: text().$type<PriorWork.Kind>().notNull(),
    head_revision: integer().notNull(),
    state: text().$type<PriorWork.State>().notNull(),
    // The Session allowed to revise or retract besides a human. Not a foreign key: records outlive
    // the Sessions that wrote them.
    recording_session_id: text().$type<SessionSchema.ID>(),
    time_created: integer().notNull(),
  },
  (table) => [index("prior_work_record_scope_idx").on(table.project_id, table.repository_id, table.id)],
)

/** Immutable revision content. Deletion removes these rows and keeps the record tombstone. */
export const PriorWorkRevisionTable = sqliteTable(
  "prior_work_revision",
  {
    record_id: text()
      .$type<PriorWork.RecordID>()
      .notNull()
      .references(() => PriorWorkRecordTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    summary: text().notNull(),
    detail: text().notNull(),
    method: text().notNull(),
    assumptions: text({ mode: "json" }).$type<readonly PriorWork.Assumption[]>().notNull(),
    locations: text({ mode: "json" }).$type<readonly PriorWork.Location[]>().notNull(),
    evidence: text({ mode: "json" }).$type<readonly PriorWork.Evidence[]>().notNull(),
    challenges: text({ mode: "json" }).$type<PriorWork.Challenges>(),
    derived_from: text({ mode: "json" }).$type<readonly PriorWork.RevisionRef[]>().notNull(),
    recording_capture: text({ mode: "json" }).$type<PriorWork.Capture>(),
    observation: text({ mode: "json" }).$type<PriorWork.Observation>().notNull(),
    recorded_by: text({ mode: "json" }).$type<PriorWork.RecordedBy>().notNull(),
    time_recorded: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.record_id, table.revision] })],
)

/**
 * Immutable origin, one row per record. `repository_id` is denormalised so each source entry is
 * adopted at most once per repository binding.
 */
export const PriorWorkOriginTable = sqliteTable(
  "prior_work_origin",
  {
    record_id: text()
      .$type<PriorWork.RecordID>()
      .primaryKey()
      .references(() => PriorWorkRecordTable.id, { onDelete: "cascade" }),
    repository_id: text()
      .$type<PriorWork.RepositoryID>()
      .notNull()
      .references(() => PriorWorkRepositoryTable.id, { onDelete: "cascade" }),
    author: text({ mode: "json" }).$type<PriorWork.Author>().notNull(),
    source_kind: text().$type<"live" | PriorWork.SourceKind>().notNull(),
    source_id: text(),
    source_root_session_id: text().$type<SessionSchema.ID>(),
    // Kept as a plain ID so the origin survives deletion of the observer's Session.
    source_session_id: text().$type<SessionSchema.ID>(),
    time_observed: integer().notNull(),
  },
  (table) => [uniqueIndex("prior_work_origin_source_idx").on(table.repository_id, table.source_kind, table.source_id)],
)

/** Append-only log of create, revise, retract, delete, adopt, and link actions. */
export const PriorWorkEventTable = sqliteTable(
  "prior_work_event",
  {
    id: text().$type<PriorWork.EventID>().primaryKey(),
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    repository_id: text()
      .$type<PriorWork.RepositoryID>()
      .notNull()
      .references(() => PriorWorkRepositoryTable.id, { onDelete: "cascade" }),
    record_id: text()
      .$type<PriorWork.RecordID>()
      .references(() => PriorWorkRecordTable.id, { onDelete: "cascade" }),
    action: text().$type<"create" | "revise" | "retract" | "delete" | "adopt" | "link">().notNull(),
    actor: text({ mode: "json" }).$type<PriorWork.Actor>().notNull(),
    session_id: text().$type<SessionSchema.ID>(),
    revision: integer(),
    // Retraction reason; blanked when the record is deleted.
    reason: text(),
    target_repository_id: text().$type<PriorWork.RepositoryID>(),
    time_created: integer().notNull(),
  },
  (table) => [index("prior_work_event_record_idx").on(table.record_id, table.id)],
)

/** Session-scoped idempotency keys with the SHA-256 of the canonical submitted intent. */
export const PriorWorkIdempotencyTable = sqliteTable(
  "prior_work_idempotency",
  {
    session_id: text().$type<SessionSchema.ID>().notNull(),
    key: text().notNull(),
    intent_hash: text().notNull(),
    record_id: text()
      .$type<PriorWork.RecordID>()
      .notNull()
      .references(() => PriorWorkRecordTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.key] })],
)
