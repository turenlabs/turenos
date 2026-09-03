import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { Settlement } from "./registry"

type ToolExecutionStatus = "running" | "completed" | "indeterminate"

/**
 * Stored form of a settlement. `result` is omitted when `output` is present: the registry
 * constructed it as `ToolOutput.toResultValue(output)`, so the read path rebuilds it exactly.
 * Persisting both doubled the payload of every completed row — at scale this column was the
 * single largest redundancy in the database. Rows written before this change carry both
 * fields and read back unchanged.
 */
export type StoredSettlement = Omit<Settlement, "result"> & { readonly result?: Settlement["result"] }

export const ToolExecutionTable = sqliteTable(
  "tool_execution",
  {
    session_id: text().$type<SessionSchema.ID>().notNull(),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    call_id: text().notNull(),
    request_hash: text().notNull(),
    retryable_error: integer({ mode: "boolean" }).notNull().default(false),
    status: text().$type<ToolExecutionStatus>().notNull(),
    owner_id: text(),
    settlement: text({ mode: "json" }).$type<StoredSettlement>(),
    lease_expires_at: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.assistant_message_id, table.call_id] })],
)
