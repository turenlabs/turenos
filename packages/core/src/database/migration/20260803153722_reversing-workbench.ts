import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803153722_reversing-workbench",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`reversing_annotation\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`artifact_id\` text,
          \`kind\` text NOT NULL,
          \`layer\` text NOT NULL,
          \`target_kind\` text NOT NULL,
          \`reference_id\` text NOT NULL,
          \`value\` text NOT NULL,
          \`author\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_annotation_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_reversing_annotation_artifact_id_reversing_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`reversing_artifact\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_evidence\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`execution_id\` text,
          \`hypothesis_id\` text,
          \`finding_id\` text,
          \`artifact_id\` text,
          \`locator_kind\` text NOT NULL,
          \`reference_id\` text,
          \`address\` text,
          \`excerpt\` text NOT NULL,
          \`author\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_evidence_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_reversing_evidence_hypothesis_id_reversing_hypothesis_id_fk\` FOREIGN KEY (\`hypothesis_id\`) REFERENCES \`reversing_hypothesis\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_reversing_evidence_finding_id_reversing_finding_id_fk\` FOREIGN KEY (\`finding_id\`) REFERENCES \`reversing_finding\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_reversing_evidence_artifact_id_reversing_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`reversing_artifact\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_finding\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`severity\` text NOT NULL,
          \`confidence\` real,
          \`title\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`status\` text NOT NULL,
          \`author\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_finding_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_hypothesis\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`claim\` text NOT NULL,
          \`status\` text NOT NULL,
          \`confidence\` real,
          \`note\` text,
          \`author\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_reversing_hypothesis_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reversing_steer\` (
          \`id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`execution_id\` text,
          \`text\` text NOT NULL,
          \`author\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_consumed\` integer,
          CONSTRAINT \`fk_reversing_steer_case_id_reversing_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`reversing_case\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`reversing_annotation_case_idx\` ON \`reversing_annotation\` (\`case_id\`,\`target_kind\`,\`reference_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`reversing_annotation_target_idx\` ON \`reversing_annotation\` (\`case_id\`,\`kind\`,\`layer\`,\`target_kind\`,\`reference_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`reversing_evidence_case_idx\` ON \`reversing_evidence\` (\`case_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`reversing_evidence_hypothesis_idx\` ON \`reversing_evidence\` (\`hypothesis_id\`);`)
      yield* tx.run(`CREATE INDEX \`reversing_evidence_finding_idx\` ON \`reversing_evidence\` (\`finding_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`reversing_finding_case_idx\` ON \`reversing_finding\` (\`case_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`reversing_hypothesis_case_idx\` ON \`reversing_hypothesis\` (\`case_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`reversing_steer_case_idx\` ON \`reversing_steer\` (\`case_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`reversing_steer_pending_idx\` ON \`reversing_steer\` (\`case_id\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
