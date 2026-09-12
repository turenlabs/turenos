import { SwarmRoom } from "@turenlabs/schema/swarm-room"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AgentV2 } from "../agent"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

/**
 * One room per swarm root Session. `head` is the monotonic append target that
 * doubles as the CAS revision for coordination writes.
 */
export const SwarmRoomTable = sqliteTable("swarm_room", {
  id: text().$type<SwarmRoom.ID>().primaryKey(),
  root_session_id: text()
    .$type<SessionSchema.ID>()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  objective: text().notNull(),
  budget: integer().notNull(),
  explicit_budget: integer({ mode: "boolean" }).notNull(),
  head: integer().notNull(),
  status: text({ enum: SwarmRoom.RoomStatus.literals })
    .$type<(typeof SwarmRoom.RoomStatus)["Type"]>()
    .notNull(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
}, (table) => [uniqueIndex("swarm_room_root_idx").on(table.root_session_id)])

/**
 * Agent membership is derived from the session task graph, so only humans and
 * system markers are stored here.
 */
export const SwarmRoomMemberTable = sqliteTable(
  "swarm_room_member",
  {
    id: text().$type<SwarmRoom.MemberID>().primaryKey(),
    room_id: text()
      .$type<SwarmRoom.ID>()
      .notNull()
      .references(() => SwarmRoomTable.id, { onDelete: "cascade" }),
    type: text({ enum: SwarmRoom.ActorType.literals })
      .$type<(typeof SwarmRoom.ActorType)["Type"]>()
      .notNull(),
    name: text().notNull(),
    state: text({ enum: SwarmRoom.MemberState.literals })
      .$type<(typeof SwarmRoom.MemberState)["Type"]>()
      .notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("swarm_room_member_room_idx").on(table.room_id),
    uniqueIndex("swarm_room_member_name_idx").on(table.room_id, table.name),
  ],
)

/**
 * Append-only sequenced stream. `seq` is unique per room so readers can resume
 * after a known position; `base_revision` records the head the writer read.
 */
export const SwarmRoomEntryTable = sqliteTable(
  "swarm_room_entry",
  {
    id: text().$type<SwarmRoom.EntryID>().primaryKey(),
    room_id: text()
      .$type<SwarmRoom.ID>()
      .notNull()
      .references(() => SwarmRoomTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    member_id: text().$type<SwarmRoom.MemberID>().notNull(),
    actor_type: text({ enum: SwarmRoom.ActorType.literals })
      .$type<(typeof SwarmRoom.ActorType)["Type"]>()
      .notNull(),
    actor_session_id: text().$type<SessionSchema.ID>(),
    actor_agent: text().$type<AgentV2.ID>(),
    actor_name: text().notNull(),
    kind: text({ enum: SwarmRoom.Kind.literals })
      .$type<(typeof SwarmRoom.Kind)["Type"]>()
      .notNull(),
    text: text().notNull(),
    payload: text({ mode: "json" }).$type<unknown>(),
    reply_to: text().$type<SwarmRoom.EntryID>(),
    evidence_refs: text({ mode: "json" }).$type<string[]>(),
    base_revision: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("swarm_room_entry_room_seq_idx").on(table.room_id, table.seq),
    index("swarm_room_entry_kind_idx").on(table.room_id, table.kind, table.seq),
  ],
)
