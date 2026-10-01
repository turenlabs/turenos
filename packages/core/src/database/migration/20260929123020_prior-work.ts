import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260929123020_prior-work",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`prior_work_event\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`repository_id\` text NOT NULL,
          \`record_id\` text,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`session_id\` text,
          \`revision\` integer,
          \`reason\` text,
          \`target_repository_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_prior_work_event_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_prior_work_event_repository_id_prior_work_repository_id_fk\` FOREIGN KEY (\`repository_id\`) REFERENCES \`prior_work_repository\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_prior_work_event_record_id_prior_work_record_id_fk\` FOREIGN KEY (\`record_id\`) REFERENCES \`prior_work_record\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prior_work_idempotency\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`intent_hash\` text NOT NULL,
          \`record_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`prior_work_idempotency_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_prior_work_idempotency_record_id_prior_work_record_id_fk\` FOREIGN KEY (\`record_id\`) REFERENCES \`prior_work_record\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prior_work_link\` (
          \`repository_id\` text NOT NULL,
          \`target_repository_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`prior_work_link_pk\` PRIMARY KEY(\`repository_id\`, \`target_repository_id\`),
          CONSTRAINT \`fk_prior_work_link_repository_id_prior_work_repository_id_fk\` FOREIGN KEY (\`repository_id\`) REFERENCES \`prior_work_repository\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_prior_work_link_target_repository_id_prior_work_repository_id_fk\` FOREIGN KEY (\`target_repository_id\`) REFERENCES \`prior_work_repository\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prior_work_origin\` (
          \`record_id\` text PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`author\` text NOT NULL,
          \`source_kind\` text NOT NULL,
          \`source_id\` text,
          \`source_root_session_id\` text,
          \`source_session_id\` text,
          \`time_observed\` integer NOT NULL,
          CONSTRAINT \`fk_prior_work_origin_record_id_prior_work_record_id_fk\` FOREIGN KEY (\`record_id\`) REFERENCES \`prior_work_record\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_prior_work_origin_repository_id_prior_work_repository_id_fk\` FOREIGN KEY (\`repository_id\`) REFERENCES \`prior_work_repository\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prior_work_record\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`repository_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`head_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`recording_session_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_prior_work_record_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_prior_work_record_repository_id_prior_work_repository_id_fk\` FOREIGN KEY (\`repository_id\`) REFERENCES \`prior_work_repository\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prior_work_repository\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`dev\` integer NOT NULL,
          \`ino\` integer NOT NULL,
          \`birthtime\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_prior_work_repository_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`prior_work_revision\` (
          \`record_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`summary\` text NOT NULL,
          \`detail\` text NOT NULL,
          \`method\` text NOT NULL,
          \`assumptions\` text NOT NULL,
          \`locations\` text NOT NULL,
          \`evidence\` text NOT NULL,
          \`challenges\` text,
          \`derived_from\` text NOT NULL,
          \`recording_capture\` text,
          \`observation\` text NOT NULL,
          \`recorded_by\` text NOT NULL,
          \`time_recorded\` integer NOT NULL,
          CONSTRAINT \`prior_work_revision_pk\` PRIMARY KEY(\`record_id\`, \`revision\`),
          CONSTRAINT \`fk_prior_work_revision_record_id_prior_work_record_id_fk\` FOREIGN KEY (\`record_id\`) REFERENCES \`prior_work_record\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`prior_work_event_record_idx\` ON \`prior_work_event\` (\`record_id\`,\`id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`prior_work_origin_source_idx\` ON \`prior_work_origin\` (\`repository_id\`,\`source_kind\`,\`source_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`prior_work_record_scope_idx\` ON \`prior_work_record\` (\`project_id\`,\`repository_id\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`prior_work_repository_incarnation_idx\` ON \`prior_work_repository\` (\`project_id\`,\`dev\`,\`ino\`,\`birthtime\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
