import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ModelV2 } from "../model"
import type { Loop } from "../loop"

export const LoopTable = sqliteTable(
  "loop",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    prompt: text().notNull(),
    directory: text().notNull(),
    workspace_id: text(),
    agent: text(),
    model: text({ mode: "json" }).$type<ModelV2.Ref>(),
    skill: text(),
    workflow: text({ mode: "json" }).$type<Loop.Workflow>(),
    status: text({ enum: ["active", "paused", "expired"] }).notNull(),
    schedule_type: text({ enum: ["interval"] }).notNull(),
    interval_seconds: integer().notNull(),
    timezone: text().notNull(),
    overlap_policy: text({ enum: ["skip"] }).notNull(),
    starts_at: integer().notNull(),
    next_run_at: integer(),
    expires_at: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("loop_status_due_idx").on(table.status, table.next_run_at),
    index("loop_created_idx").on(table.time_created, table.id),
  ],
)

export const LoopRunTable = sqliteTable(
  "loop_run",
  {
    id: text().primaryKey(),
    loop_id: text()
      .notNull()
      .references(() => LoopTable.id, { onDelete: "cascade" }),
    scheduled_at: integer().notNull(),
    trigger: text({ enum: ["scheduled", "manual"] }).notNull(),
    status: text({ enum: ["claimed", "running", "succeeded", "failed", "cancelled", "skipped", "stale"] }).notNull(),
    current_step: integer().notNull().default(0),
    step_outputs: text({ mode: "json" }).notNull().$type<Loop.StepOutputs>().default({}),
    lease_owner: text(),
    lease_expires_at: integer(),
    session_id: text(),
    execution_title: text(),
    execution_prompt: text(),
    execution_directory: text(),
    execution_workspace_id: text(),
    execution_agent: text(),
    execution_model: text({ mode: "json" }).$type<ModelV2.Ref>(),
    execution_skill: text(),
    execution_workflow: text({ mode: "json" }).$type<Loop.Workflow>(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_started: integer(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("loop_run_occurrence_idx").on(table.loop_id, table.scheduled_at),
    index("loop_run_status_lease_idx").on(table.status, table.lease_expires_at),
    index("loop_run_loop_created_idx").on(table.loop_id, table.time_created, table.id),
  ],
)
