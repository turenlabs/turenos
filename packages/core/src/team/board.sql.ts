import { TeamBoard } from "@turenlabs/schema/team-board"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AgentV2 } from "../agent"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

export const TeamBoardNoteTable = sqliteTable(
  "team_board_note",
  {
    id: text().$type<TeamBoard.ID>().primaryKey(),
    root_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    author_session_id: text().$type<SessionSchema.ID>().notNull(),
    author_agent: text().$type<AgentV2.ID>().notNull(),
    kind: text({
      enum: ["finding", "correction", "lead", "refuted", "capability", "status"],
    }).notNull(),
    title: text().notNull(),
    body: text().notNull(),
    evidence: text(),
    supersedes: text().$type<TeamBoard.ID>(),
    superseded_by: text().$type<TeamBoard.ID>(),
    revision: integer().notNull(),
    parent_notification_status: text({ enum: ["none", "pending", "delivered"] })
      .$type<"none" | "pending" | "delivered">()
      .notNull()
      .default("none"),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("team_board_root_idx").on(table.root_session_id, table.time_created, table.id),
    index("team_board_pending_notification_idx").on(table.parent_notification_status, table.time_created, table.id),
  ],
)
