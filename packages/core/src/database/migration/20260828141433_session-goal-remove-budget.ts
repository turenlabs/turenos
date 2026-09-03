import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828141433_session-goal-remove-budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`UPDATE \`session_goal\` SET \`status\` = 'paused' WHERE \`status\` = 'budgetLimited';`)
      yield* tx.run(`
        UPDATE \`event\`
        SET \`data\` = json_remove(
          CASE
            WHEN json_extract(\`data\`, '$.goal.status') = 'budgetLimited'
              THEN json_set(\`data\`, '$.goal.status', 'paused')
            ELSE \`data\`
          END,
          '$.goal.tokenBudget'
        )
        WHERE \`type\` IN ('session.next.goal.updated', 'session.next.goal.updated.1');
      `)
      yield* tx.run(`ALTER TABLE \`session_goal_identity\` DROP COLUMN \`token_budget\`;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` DROP COLUMN \`token_budget\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
