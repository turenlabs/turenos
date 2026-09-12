import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911134454_swarm-room",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`swarm_room_entry\` (
          \`id\` text PRIMARY KEY,
          \`room_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`member_id\` text NOT NULL,
          \`actor_type\` text NOT NULL,
          \`actor_session_id\` text,
          \`actor_agent\` text,
          \`actor_name\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`text\` text NOT NULL,
          \`payload\` text,
          \`reply_to\` text,
          \`evidence_refs\` text,
          \`base_revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_swarm_room_entry_room_id_swarm_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`swarm_room\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_room_member\` (
          \`id\` text PRIMARY KEY,
          \`room_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`name\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_swarm_room_member_room_id_swarm_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`swarm_room\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_room\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`budget\` integer NOT NULL,
          \`explicit_budget\` integer NOT NULL,
          \`head\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_swarm_room_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_room_entry_room_seq_idx\` ON \`swarm_room_entry\` (\`room_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_room_entry_kind_idx\` ON \`swarm_room_entry\` (\`room_id\`,\`kind\`,\`seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_room_member_room_idx\` ON \`swarm_room_member\` (\`room_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
