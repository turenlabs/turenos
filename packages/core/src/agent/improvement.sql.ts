import { AgentImprovement } from "@turenlabs/schema/agent-improvement"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AgentV2 } from "../agent"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

export const AgentImprovementProposalTable = sqliteTable(
  "agent_improvement_proposal",
  {
    id: text().$type<AgentImprovement.ID>().primaryKey(),
    root_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    agent: text().$type<AgentV2.ID>().notNull(),
    author_session_id: text().$type<SessionSchema.ID>().notNull(),
    author_agent: text().$type<AgentV2.ID>().notNull(),
    baseline_markdown: text().notNull(),
    proposal_markdown: text().notNull(),
    rationale: text().notNull(),
    evidence: text().notNull(),
    status: text({
      enum: ["proposed", "validated", "accepted", "rejected"],
    }).notNull(),
    validation: text(),
    error: text(),
    revision: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("agent_improvement_root_idx").on(table.root_session_id, table.time_created, table.id)],
)
