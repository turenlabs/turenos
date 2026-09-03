import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260807163145_red_bucky",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`pentest_evidence\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`execution_id\` text,
          \`hypothesis_id\` text,
          \`finding_id\` text,
          \`locator_kind\` text NOT NULL,
          \`reference\` text,
          \`excerpt\` text NOT NULL,
          \`author\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_evidence_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_pentest_evidence_hypothesis_id_pentest_hypothesis_id_fk\` FOREIGN KEY (\`hypothesis_id\`) REFERENCES \`pentest_hypothesis\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_pentest_evidence_finding_id_pentest_finding_id_fk\` FOREIGN KEY (\`finding_id\`) REFERENCES \`pentest_finding\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_execution\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`result_run_revision\` integer NOT NULL,
          \`attempt\` integer NOT NULL,
          \`model_json\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`profile_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`stage\` text NOT NULL,
          \`cancel_requested\` integer NOT NULL,
          \`cancel_idempotency_key\` text,
          \`cancel_request_hash\` text,
          \`cancel_result_run_revision\` integer,
          \`fence\` integer NOT NULL,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`last_heartbeat\` integer,
          \`checkpoint_json\` text,
          \`absolute_ttl\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_execution_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_finding\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`severity\` text NOT NULL,
          \`confidence\` real,
          \`title\` text NOT NULL,
          \`type\` text NOT NULL,
          \`endpoint\` text NOT NULL,
          \`cvss_vector\` text,
          \`cvss_score\` real NOT NULL,
          \`owasp\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`remediation\` text NOT NULL,
          \`reproduction\` text,
          \`status\` text NOT NULL,
          \`author\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_finding_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_hypothesis\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`claim\` text NOT NULL,
          \`status\` text NOT NULL,
          \`confidence\` real,
          \`note\` text,
          \`author\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_hypothesis_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_report\` (
          \`run_id\` text PRIMARY KEY,
          \`markdown\` text NOT NULL,
          \`generated_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_report_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_run\` (
          \`id\` text PRIMARY KEY,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`current_stage\` text NOT NULL,
          \`labels_json\` text NOT NULL,
          \`goal_json\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_steer\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`execution_id\` text,
          \`text\` text NOT NULL,
          \`author\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_consumed\` integer,
          CONSTRAINT \`fk_pentest_steer_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`pentest_evidence_run_idx\` ON \`pentest_evidence\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_evidence_hypothesis_idx\` ON \`pentest_evidence\` (\`hypothesis_id\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_evidence_finding_idx\` ON \`pentest_evidence\` (\`finding_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`pentest_execution_run_attempt_idx\` ON \`pentest_execution\` (\`run_id\`,\`attempt\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`pentest_execution_idempotency_idx\` ON \`pentest_execution\` (\`run_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pentest_execution_run_idx\` ON \`pentest_execution\` (\`run_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pentest_execution_claim_idx\` ON \`pentest_execution\` (\`state\`,\`lease_until\`,\`absolute_ttl\`);`,
      )
      yield* tx.run(`CREATE INDEX \`pentest_finding_run_idx\` ON \`pentest_finding\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_finding_severity_idx\` ON \`pentest_finding\` (\`run_id\`,\`severity\`);`)
      yield* tx.run(
        `CREATE INDEX \`pentest_hypothesis_run_idx\` ON \`pentest_hypothesis\` (\`run_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`pentest_report_run_idx\` ON \`pentest_report\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`pentest_run_idempotency_idx\` ON \`pentest_run\` (\`idempotency_key\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_run_list_idx\` ON \`pentest_run\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_steer_run_idx\` ON \`pentest_steer\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_steer_pending_idx\` ON \`pentest_steer\` (\`run_id\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
