import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729220024_loop-run-snapshot",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_title\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_prompt\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_directory\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_workspace_id\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_agent\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_model\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_skill\` text;`)
      yield* tx.run(`UPDATE \`loop_run\`
        SET \`status\` = 'stale', \`lease_owner\` = NULL, \`lease_expires_at\` = NULL,
            \`time_updated\` = unixepoch('subsec') * 1000, \`time_completed\` = unixepoch('subsec') * 1000
        WHERE \`status\` = 'running'
          AND (\`lease_expires_at\` IS NULL OR \`lease_expires_at\` <= unixepoch('subsec') * 1000);`)
      yield* tx.run(`UPDATE \`loop_run\`
        SET \`execution_title\` = (SELECT \`name\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`),
            \`execution_prompt\` = (SELECT \`prompt\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`),
            \`execution_directory\` = (SELECT \`directory\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`),
            \`execution_workspace_id\` = (SELECT \`workspace_id\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`),
            \`execution_agent\` = (SELECT \`agent\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`),
            \`execution_model\` = (SELECT \`model\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`),
            \`execution_skill\` = (SELECT \`skill\` FROM \`loop\` WHERE \`loop\`.\`id\` = \`loop_run\`.\`loop_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
