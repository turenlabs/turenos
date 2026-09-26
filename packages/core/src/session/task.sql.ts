import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import type { PermissionV2 } from "../permission"
import type { Prompt } from "./prompt"
import type { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import type { SessionTask } from "@turenlabs/schema/session-task"
import { SessionTable } from "./sql"

export const SessionTaskTable = sqliteTable(
  "session_task",
  {
    id: text().$type<SessionTask.ID>().primaryKey(),
    root_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    child_session_id: text().$type<SessionSchema.ID>().notNull().unique(),
    parent_task_id: text()
      .$type<SessionTask.ID>()
      .references((): AnySQLiteColumn => SessionTaskTable.id, { onDelete: "cascade" }),
    actor_session_id: text().$type<SessionSchema.ID>().notNull(),
    actor_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    actor_tool_call_id: text().notNull(),
    // -1 marks a single-operation tool call. A nullable column would let SQLite
    // treat two NULL items as distinct and break the actor uniqueness indexes.
    actor_item: integer().notNull().default(-1),
    agent: text().$type<AgentV2.ID>().notNull(),
    model: text({ mode: "json" }).$type<ModelV2.Ref>(),
    prompt: text({ mode: "json" }).$type<Prompt>().notNull(),
    description: text().notNull(),
    wave: text(),
    depth: integer().notNull(),
    status: text().$type<SessionTask.Status>().notNull(),
    revision: integer().notNull(),
    parent_permissions: text({ mode: "json" }).$type<PermissionV2.Ruleset>().notNull(),
    ancestor_permission_sets: text({ mode: "json" }).$type<PermissionV2.Ruleset[]>().notNull(),
    child_permissions: text({ mode: "json" }).$type<PermissionV2.Ruleset>().notNull(),
    hard_permissions: text({ mode: "json" }).$type<PermissionV2.Ruleset>().notNull(),
    write_roots: text({ mode: "json" }).$type<string[]>().notNull(),
    commands: text({ mode: "json" }).$type<string[]>().notNull(),
    orchestrate: integer({ mode: "boolean" }).notNull().default(false),
    result: text(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_started: integer(),
    time_completed: integer(),
  },
  (table) => [
    index("session_task_root_status_idx").on(table.root_session_id, table.status),
    index("session_task_root_created_idx").on(table.root_session_id, table.time_created, table.id),
    index("session_task_parent_created_idx").on(table.parent_session_id, table.time_created, table.id),
    index("session_task_parent_task_idx").on(table.parent_task_id),
    index("session_task_status_created_idx").on(table.status, table.time_created),
    index("session_task_parent_wave_idx").on(table.parent_session_id, table.wave),
  ],
)

export const SessionTaskActorClaimTable = sqliteTable(
  "session_task_actor_claim",
  {
    id: text().primaryKey(),
    actor_session_id: text().$type<SessionSchema.ID>().notNull(),
    actor_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    actor_tool_call_id: text().notNull(),
    actor_item: integer().notNull().default(-1),
    operation_id: text().$type<SessionTask.OperationID>().notNull().unique(),
    task_id: text().$type<SessionTask.ID>().notNull(),
    kind: text().$type<SessionTask.OperationKind>().notNull(),
    request_hash: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_task_actor_claim_actor_idx").on(
      table.actor_session_id,
      table.actor_assistant_message_id,
      table.actor_tool_call_id,
      table.actor_item,
    ),
    index("session_task_actor_claim_task_idx").on(table.task_id),
  ],
)

export const SessionTaskOperationTable = sqliteTable(
  "session_task_operation",
  {
    id: text().$type<SessionTask.OperationID>().primaryKey(),
    task_id: text()
      .$type<SessionTask.ID>()
      .notNull()
      .references(() => SessionTaskTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    actor_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    actor_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    actor_tool_call_id: text().notNull(),
    actor_item: integer().notNull().default(-1),
    kind: text().$type<SessionTask.OperationKind>().notNull(),
    request_hash: text().notNull(),
    message_id: text().$type<SessionMessage.ID>(),
    prompt: text({ mode: "json" }).$type<Prompt>(),
    status: text().$type<SessionTask.OperationStatus>().notNull(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("session_task_operation_actor_idx").on(
      table.actor_session_id,
      table.actor_assistant_message_id,
      table.actor_tool_call_id,
      table.actor_item,
    ),
    index("session_task_operation_task_idx").on(table.task_id, table.time_created),
    index("session_task_operation_status_created_idx").on(table.status, table.time_created),
    uniqueIndex("session_task_operation_message_idx").on(table.message_id),
    index("session_task_operation_applied_message_task_idx")
      .on(table.message_id, table.task_id)
      .where(sql`${table.status} = 'applied' AND ${table.message_id} IS NOT NULL`),
  ],
)
