import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const tables = [
  "reversing_annotation",
  "reversing_evidence",
  "reversing_finding",
  "reversing_hypothesis",
  "reversing_steer",
  "reversing_case_artifact",
  "reversing_execution",
  "reversing_goal_revision",
  "reversing_case",
  "reversing_upload",
  "reversing_artifact",
  "reversing_blob",
]

export default {
  id: "20260822133903_remove-reversing-workbench",
  up(tx) {
    return Effect.forEach(tables, (table) => tx.run(`DROP TABLE IF EXISTS \`${table}\``), { discard: true })
  },
} satisfies DatabaseMigration.Migration
