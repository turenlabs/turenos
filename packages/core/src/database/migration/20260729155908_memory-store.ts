import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729155908_memory-store",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_drawer\` (
          \`id\` text PRIMARY KEY,
          \`wing_id\` text NOT NULL,
          \`room_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`anchor_repo\` text,
          \`anchor_path\` text,
          \`anchor_commit\` text,
          \`anchor_symbol\` text,
          \`asserted_by\` text NOT NULL,
          \`source\` text NOT NULL,
          \`session_id\` text,
          \`time_valid_from\` integer NOT NULL,
          \`time_valid_until\` integer,
          \`superseded_by\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_drawer_wing_id_memory_wing_id_fk\` FOREIGN KEY (\`wing_id\`) REFERENCES \`memory_wing\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_drawer_room_id_memory_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`memory_room\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_drawer_superseded_by_memory_drawer_id_fk\` FOREIGN KEY (\`superseded_by\`) REFERENCES \`memory_drawer\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_room\` (
          \`id\` text PRIMARY KEY,
          \`wing_id\` text NOT NULL,
          \`slug\` text NOT NULL,
          \`name\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_room_wing_id_memory_wing_id_fk\` FOREIGN KEY (\`wing_id\`) REFERENCES \`memory_wing\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_wing\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`key\` text NOT NULL,
          \`name\` text NOT NULL,
          \`project_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_wing_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`memory_drawer_wing_valid_idx\` ON \`memory_drawer\` (\`wing_id\`,\`time_valid_until\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_drawer_room_idx\` ON \`memory_drawer\` (\`room_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_drawer_anchor_idx\` ON \`memory_drawer\` (\`wing_id\`,\`anchor_repo\`,\`anchor_path\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_drawer_session_idx\` ON \`memory_drawer\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_room_wing_slug_idx\` ON \`memory_room\` (\`wing_id\`,\`slug\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_wing_kind_key_idx\` ON \`memory_wing\` (\`kind\`,\`key\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
