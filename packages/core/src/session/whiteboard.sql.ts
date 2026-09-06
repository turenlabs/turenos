import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { SessionID } from "@turenlabs/schema/session-id"
import { SessionTable } from "./sql"

export const SessionWhiteboardTable = sqliteTable("session_whiteboard", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  revision: integer().notNull(),
  elements: text({ mode: "json" }).$type<Whiteboard.Snapshot["elements"]>().notNull(),
  files: text({ mode: "json" }).$type<Whiteboard.Snapshot["files"]>().notNull(),
  updated_at: integer().notNull(),
})
