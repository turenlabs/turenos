import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const DataMigrationTable = sqliteTable("data_migration", {
  name: text().primaryKey(),
  time_completed: integer().notNull(),
  source_fingerprint: text(),
  source_version: text(),
  row_count: integer(),
  time_verified: integer(),
})
