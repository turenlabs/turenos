import { sqliteTable, text, integer, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"

import { AccountV2 } from "../account"
import { Timestamps } from "../database/schema.sql"

// `id` is minted by this install and is the only durable account identity:
// it keys the row and derives the secret vault scope for the sealed tokens.
// `remote_id` is the control plane's user id, which that server is free to
// reissue, so it is a lookup attribute only. The default is a migration
// artifact — every write supplies it.
export const AccountTable = sqliteTable(
  "account",
  {
    id: text().$type<AccountV2.ID>().primaryKey(),
    remote_id: text()
      .$type<AccountV2.RemoteID>()
      .notNull()
      .default("" as AccountV2.RemoteID),
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().notNull(),
    refresh_token: text().notNull(),
    token_expiry: integer(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("account_url_remote_idx").on(table.url, table.remote_id)],
)

export const AccountStateTable = sqliteTable("account_state", {
  id: integer().primaryKey(),
  active_account_id: text()
    .$type<AccountV2.ID>()
    .references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text().$type<AccountV2.OrgID>(),
})

// LEGACY
export const ControlAccountTable = sqliteTable(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().notNull(),
    refresh_token: text().notNull(),
    token_expiry: integer(),
    active: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
