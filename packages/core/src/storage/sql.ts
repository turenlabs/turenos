import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Storage } from "@turenlabs/schema/storage"

export const StorageStateTable = sqliteTable(
  "storage_state",
  {
    scope: text().$type<Storage.Scope>().notNull(),
    key: text().$type<Storage.Key>().notNull(),
    value: text().notNull(),
    revision: integer().notNull(),
    deleted: integer({ mode: "boolean" }).notNull().default(false),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
)
