import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Team } from "@turenlabs/schema/team"
import type { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import { LoopRunTable, LoopTable } from "../loop/sql"

export type TeamTaskSnapshot = {
  readonly name: string
  readonly handle: string
  readonly mission: string
  readonly directory: string
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly prompt: string
  readonly historyBound?: boolean
}

export const TeamRoomTable = sqliteTable(
  "team_room",
  {
    id: text().$type<Team.Room["id"]>().primaryKey(),
    name: text().notNull(),
    topic: text().notNull(),
    head: integer().notNull().default(0),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    factory_config: text({ mode: "json" }).$type<Team.FactoryConfig>(),
    factory_revision: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [uniqueIndex("team_room_name_idx").on(table.name)],
)

export const TeamTeammateTable = sqliteTable(
  "team_teammate",
  {
    id: text().$type<Team.Teammate["id"]>().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => TeamRoomTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    handle: text().notNull(),
    role: text().notNull(),
    mission: text().notNull(),
    status: text({ enum: ["active", "paused"] }).notNull(),
    directory: text().notNull(),
    agent: text().$type<AgentV2.ID>(),
    model: text({ mode: "json" }).$type<ModelV2.Ref>(),
    avatar: text({ mode: "json" }).$type<Team.Avatar>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("team_teammate_handle_idx").on(table.room_id, table.handle),
    index("team_teammate_room_idx").on(table.room_id),
  ],
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    id: text().$type<Team.Message["id"]>().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => TeamRoomTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    source_key: text(),
    kind: text({ enum: ["human", "teammate", "system"] }).notNull(),
    author: text().notNull(),
    teammate_id: text().references(() => TeamTeammateTable.id, { onDelete: "set null" }),
    text: text().notNull(),
    reply_to: text(),
    session_id: text(),
    source_message_ids: text({ mode: "json" }).$type<Team.Message["sourceMessageIDs"]>(),
    run_id: text(),
    loop_id: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("team_message_room_seq_idx").on(table.room_id, table.seq),
    uniqueIndex("team_message_source_idx").on(table.source_key),
    index("team_message_room_time_idx").on(table.room_id, table.time_created),
  ],
)

export const TeamDutyTable = sqliteTable(
  "team_duty",
  {
    loop_id: text()
      .primaryKey()
      .references(() => LoopTable.id, { onDelete: "cascade" }),
    teammate_id: text()
      .notNull()
      .references(() => TeamTeammateTable.id, { onDelete: "cascade" }),
    time_created: integer().notNull(),
  },
  (table) => [index("team_duty_teammate_idx").on(table.teammate_id)],
)

export const TeamTaskTable = sqliteTable(
  "team_task",
  {
    id: text().$type<Team.Task["id"]>().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => TeamRoomTable.id, { onDelete: "cascade" }),
    message_id: text()
      .notNull()
      .references(() => TeamMessageTable.id, { onDelete: "cascade" }),
    teammate_id: text()
      .notNull()
      .references(() => TeamTeammateTable.id, { onDelete: "cascade" }),
    session_id: text().notNull(),
    status: text({ enum: ["queued", "claimed", "running", "succeeded", "failed", "cancelled", "stale"] }).notNull(),
    snapshot: text({ mode: "json" }).notNull().$type<TeamTaskSnapshot>(),
    factory_run_id: text(),
    error: text(),
    lease_owner: text(),
    lease_expires_at: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("team_task_status_lease_idx").on(table.status, table.lease_expires_at),
    index("team_task_teammate_status_idx").on(table.teammate_id, table.status),
    uniqueIndex("team_task_message_teammate_idx").on(table.message_id, table.teammate_id),
  ],
)

export const TeamDutyRunTable = sqliteTable("team_duty_run", {
  run_id: text()
    .primaryKey()
    .references(() => LoopRunTable.id, { onDelete: "cascade" }),
  loop_id: text()
    .notNull()
    .references(() => LoopTable.id, { onDelete: "cascade" }),
  teammate_id: text()
    .notNull()
    .references(() => TeamTeammateTable.id, { onDelete: "cascade" }),
  room_id: text()
    .notNull()
    .references(() => TeamRoomTable.id, { onDelete: "cascade" }),
  author: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<Team.Teammate>(),
  time_created: integer().notNull(),
})

export const TeamFactoryRunTable = sqliteTable(
  "team_factory_run",
  {
    id: text().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => TeamRoomTable.id, { onDelete: "cascade" }),
    request: text().notNull(),
    source_loop_run_id: text(),
    status: text({ enum: ["running", "succeeded", "needs_input", "failed", "cancelled", "stale"] }).notNull(),
    phase: text({ enum: ["plan", "work", "check", "done"] }).notNull(),
    config: text({ mode: "json" }).notNull().$type<Team.FactoryConfig>(),
    profiles: text({ mode: "json" }).notNull().$type<ReadonlyArray<Team.Teammate>>(),
    task_ids: text({ mode: "json" }).notNull().$type<ReadonlyArray<string>>().default([]),
    result: text(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("team_factory_run_room_status_idx").on(table.room_id, table.status)],
)
