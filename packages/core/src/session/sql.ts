import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionEvent } from "./event"
import type { SessionMessage } from "./message"
import type { SessionStatus } from "./status"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import type { ProviderV2 } from "../provider"
import type { Revert } from "@turenlabs/schema/revert"
import type { SessionGoal } from "@turenlabs/schema/session-goal"
import type { SessionHarness } from "@turenlabs/schema/session-harness"
import type { Source } from "@turenlabs/schema/session-input"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">
type SessionHarnessSnapshotData = (typeof SessionHarness.HarnessSnapshot)["Encoded"]
type SessionHarnessProposalData = (typeof SessionHarness.HarnessProposal)["Encoded"]
type SessionHarnessReviewerRequestData = (typeof SessionHarness.ReviewerRequest)["Encoded"]
type SessionHarnessReviewerRunData = (typeof SessionHarness.ReviewerRun)["Encoded"]

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
    // Durable run status -- see `./status.ts`. Projected from the same durable Session events the
    // transcript is built from, so it survives a restart and is readable by anyone with the
    // database rather than only by the process holding the run coordinator's map.
    status: text().$type<SessionStatus.Type>().notNull().default("idle"),
    status_owner: text(),
    status_attempt: integer(),
    status_message: text(),
    status_next: integer(),
    status_action: text({ mode: "json" }).$type<SessionEvent.RetryAction>(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
    // The Home session index and the V2 session list page by `time_created
    // desc, id desc` over the whole table; `Session.listGlobal` pages by
    // `time_updated desc, id desc`. Without these, every page is a full scan
    // plus a temp sort.
    index("session_time_created_id_idx").on(table.time_created, table.id),
    index("session_time_updated_id_idx").on(table.time_updated, table.id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.position] })],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionTranscriptAdoptionTable = sqliteTable("session_transcript_adoption", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  state: text().$type<"adopting" | "current">().notNull(),
  version: integer().notNull(),
  time_started: integer().notNull(),
  time_completed: integer(),
})

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    source: text().$type<Source>().notNull().default("user"),
    agent: text().$type<AgentV2.ID>(),
    model: text({ mode: "json" }).$type<ModelV2.Ref>(),
    command: text({ mode: "json" }).$type<SessionInput.CommandIntent>(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_cancelled: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    index("session_input_session_pending_source_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.source,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
    index("session_input_pending_id_idx")
      .on(table.id)
      .where(sql`${table.promoted_seq} IS NULL AND ${table.time_cancelled} IS NULL`),
    index("session_input_pending_board_session_idx")
      .on(table.session_id)
      .where(
        sql`${table.source} = 'subagent_board' AND ${table.promoted_seq} IS NULL AND ${table.time_cancelled} IS NULL`,
      ),
  ],
)

export const SessionMessageIdentityTable = sqliteTable(
  "session_message_identity",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    owner: text().$type<"input" | "message">().notNull(),
    kind: text().$type<"prompt" | "command" | "goal" | "shell" | "message">().notNull(),
    input: text({ mode: "json" }).$type<{
      admitted: Omit<SessionInput.Admitted, "timeCreated"> & { readonly timeCreated: number }
      command?: SessionInput.CommandIntent
      source?: SessionInput.Source
    }>(),
    state: text().$type<"active" | "reverted">().notNull(),
    creator_seq: integer(),
    time_created: integer().notNull(),
  },
  (table) => [index("session_message_identity_session_idx").on(table.session_id)],
)

export const SessionGoalTable = sqliteTable(
  "session_goal",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    goal_id: text().$type<SessionGoal.ID>().notNull().unique(),
    revision: integer().$type<SessionGoal.Revision>().notNull(),
    objective: text().notNull(),
    status: text().$type<SessionGoal.Status>().notNull(),
    tokens_used: integer().notNull(),
    active_time_ms: integer().notNull(),
    status_changed_at: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [index("session_goal_status_idx").on(table.status)],
)

export const SessionGoalIdentityTable = sqliteTable(
  "session_goal_identity",
  {
    goal_id: text().$type<SessionGoal.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<SessionMessage.ID>().unique(),
    objective: text().notNull(),
    state: text().$type<"current" | "cleared" | "replaced">().notNull(),
    final_revision: integer().$type<SessionGoal.Revision>(),
    time_created: integer().notNull(),
    time_terminal: integer(),
  },
  (table) => [index("session_goal_identity_session_idx").on(table.session_id)],
)

export const SessionGoalTurnTable = sqliteTable(
  "session_goal_turn",
  {
    assistant_message_id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    goal_id: text().$type<SessionGoal.ID>().notNull(),
    goal_revision: integer().$type<SessionGoal.Revision>().notNull(),
    token_delta: integer().notNull(),
    active_time_ms_delta: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("session_goal_turn_session_idx").on(table.session_id)],
)

/**
 * Per-provider spend, projected from settled turns.
 *
 * One settled turn is exactly one row, keyed by the assistant message that
 * turn belongs to, so projecting the same durable `Step.Ended` twice cannot
 * double-count and a revert can take a turn back out by message id. The
 * columns hold what the turn was *billed* for, matching the session roll-up.
 */
export const ProviderUsageTable = sqliteTable(
  "provider_usage",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    provider_id: text().$type<ProviderV2.ID>().notNull(),
    time: integer().notNull(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.assistant_message_id] }),
    index("provider_usage_time_idx").on(table.time),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
})

/** Durable declarative harness state and its snapshot history for one Session. */
export const SessionHarnessTable = sqliteTable("session_harness", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  revision: integer().notNull(),
  version: integer().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SessionHarnessSnapshotData>(),
  snapshots: text({ mode: "json" }).notNull().$type<SessionHarnessSnapshotData[]>(),
  proposals: text({ mode: "json" }).notNull().$type<SessionHarnessProposalData[]>(),
  reviewer_requests: text({ mode: "json" }).notNull().$type<SessionHarnessReviewerRequestData[]>().default([]),
  reviewer_runs: text({ mode: "json" }).notNull().$type<SessionHarnessReviewerRunData[]>().default([]),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
})
