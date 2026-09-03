import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722233759_reversing_foundation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`reversing_artifact\` (
          \`id\` text PRIMARY KEY,
          \`blob_sha256\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`original_name\` text NOT NULL,
          \`media_type\` text NOT NULL,
          \`classification\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_deleted\` integer,
          CONSTRAINT \`fk_reversing_artifact_blob_sha256_reversing_blob_sha256_fk\` FOREIGN KEY (\`blob_sha256\`) REFERENCES \`reversing_blob\`(\`sha256\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_blob\` (
          \`sha256\` text PRIMARY KEY,
          \`size_bytes\` integer NOT NULL,
          \`blob_key\` text NOT NULL,
          \`state\` text NOT NULL,
          \`ref_count\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`gc_after\` integer,
          \`time_verified\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_case_artifact\` (
          \`case_id\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`reversing_case_artifact_pk\` PRIMARY KEY(\`case_id\`, \`artifact_id\`, \`role\`),
          CONSTRAINT \`fk_reversing_case_artifact_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_reversing_case_artifact_artifact_id_reversing_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`reversing_artifact\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_case\` (
          \`id\` text PRIMARY KEY,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`input_artifact_id\` text,
          \`session_id\` text,
          \`parent_case_id\` text,
          \`branch_name\` text,
          \`head_goal_revision_id\` text,
          \`status\` text NOT NULL,
          \`current_stage\` text NOT NULL,
          \`labels_json\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_case_input_artifact_id_reversing_artifact_id_fk\` FOREIGN KEY (\`input_artifact_id\`) REFERENCES \`reversing_artifact\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_execution\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`goal_revision_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`result_case_revision\` integer NOT NULL,
          \`attempt\` integer NOT NULL,
          \`model_json\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`profile_revision\` integer NOT NULL,
          \`profile_snapshot_json\` text NOT NULL,
          \`state\` text NOT NULL,
          \`stage\` text NOT NULL,
          \`cancel_requested\` integer NOT NULL,
          \`fence\` integer NOT NULL,
          \`absolute_ttl\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_execution_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_reversing_execution_goal_revision_id_reversing_goal_revision_id_fk\` FOREIGN KEY (\`goal_revision_id\`) REFERENCES \`reversing_goal_revision\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_goal_revision\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`result_case_revision\` integer NOT NULL,
          \`parent_revision_id\` text,
          \`contract_json\` text NOT NULL,
          \`author\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_goal_revision_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_upload\` (
          \`id\` text PRIMARY KEY,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`expected_name\` text NOT NULL,
          \`expected_size_bytes\` integer NOT NULL,
          \`expected_sha256\` text,
          \`next_offset\` integer NOT NULL,
          \`temporary_key\` text NOT NULL,
          \`state\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`artifact_id\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_upload_artifact_id_reversing_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`reversing_artifact\`(\`id\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`reversing_artifact_blob_idx\` ON \`reversing_artifact\` (\`blob_sha256\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_case_idempotency_idx\` ON \`reversing_case\` (\`idempotency_key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`reversing_case_list_idx\` ON \`reversing_case\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_execution_case_attempt_idx\` ON \`reversing_execution\` (\`case_id\`,\`attempt\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_execution_idempotency_idx\` ON \`reversing_execution\` (\`case_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`reversing_execution_case_idx\` ON \`reversing_execution\` (\`case_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_goal_case_revision_idx\` ON \`reversing_goal_revision\` (\`case_id\`,\`revision\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_goal_idempotency_idx\` ON \`reversing_goal_revision\` (\`case_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_upload_idempotency_idx\` ON \`reversing_upload\` (\`idempotency_key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`reversing_upload_expiry_idx\` ON \`reversing_upload\` (\`state\`,\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
