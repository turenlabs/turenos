export * as AgentImprovement from "./improvement"

import { AgentImprovement as Contract } from "@turenlabs/schema/agent-improvement"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { SessionSchema } from "../session/schema"
import { AgentImprovementProposalTable } from "./improvement.sql"

export type ID = Contract.ID
export type Status = Contract.Status
export type Proposal = Contract.Proposal
export type Failure = Contract.NotFound | Contract.Conflict | Contract.InvalidState

export type ProposeInput = {
  readonly rootSessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly authorSessionID: SessionSchema.ID
  readonly authorAgent: AgentV2.ID
  readonly proposal: string
  readonly rationale: string
  readonly evidence: string
}

export interface Interface {
  readonly propose: (input: ProposeInput) => Effect.Effect<Proposal, Contract.InvalidState>
  readonly list: (rootSessionID: SessionSchema.ID) => Effect.Effect<readonly Proposal[]>
  readonly get: (id: ID) => Effect.Effect<Proposal, Contract.NotFound>
  readonly adjudicate: (id: ID, input: { pass: boolean; validation: string }) => Effect.Effect<Proposal, Failure>
  readonly apply: (id: ID) => Effect.Effect<Proposal, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/AgentImprovement") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service

    const definitionPath = (id: AgentV2.ID) => path.join(location.directory, ".forge", "agent", `${id}.md`)

    const readDefinition = Effect.fn("AgentImprovement.readDefinition")(function* (id: AgentV2.ID) {
      const realRoot = yield* fs
        .realPath(location.directory)
        .pipe(Effect.mapError(() => new Contract.InvalidState({ message: "Active workspace root is unavailable" })))
      const realCandidate = yield* fs
        .realPath(definitionPath(id))
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (realCandidate === undefined || !FSUtil.contains(realRoot, realCandidate)) return undefined
      return yield* fs
        .readFileString(realCandidate)
        .pipe(Effect.mapError(() => new Contract.InvalidState({ message: `Unable to read agent definition: ${id}` })))
    })

    const proposalFromRow = (row: typeof AgentImprovementProposalTable.$inferSelect): Proposal => ({
      id: row.id,
      rootSessionID: SessionSchema.ID.make(row.root_session_id),
      agent: AgentV2.ID.make(row.agent),
      authorSessionID: SessionSchema.ID.make(row.author_session_id),
      authorAgent: AgentV2.ID.make(row.author_agent),
      baseline: row.baseline_markdown,
      proposal: row.proposal_markdown,
      rationale: row.rationale,
      evidence: row.evidence,
      status: row.status,
      validation: row.validation ?? undefined,
      error: row.error ?? undefined,
      revision: row.revision,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    })

    const requireProposal = Effect.fn("AgentImprovement.requireProposal")(function* (id: ID) {
      const row = yield* db
        .select()
        .from(AgentImprovementProposalTable)
        .where(eq(AgentImprovementProposalTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new Contract.NotFound({ resource: id })
      return row
    })

    return Service.of({
      propose: Effect.fn("AgentImprovement.propose")(function* (input: ProposeInput) {
        const agent = yield* agents.get(input.agent)
        if (!agent) return yield* new Contract.InvalidState({ message: `Agent is unavailable: ${input.agent}` })
        const baseline = (yield* readDefinition(input.agent)) ?? `Agent ${input.agent} is defined in code/config.`
        const now = Date.now()
        const id = Contract.ID.create()
        yield* db
          .insert(AgentImprovementProposalTable)
          .values({
            id,
            root_session_id: input.rootSessionID,
            agent: input.agent,
            author_session_id: input.authorSessionID,
            author_agent: input.authorAgent,
            baseline_markdown: baseline,
            proposal_markdown: input.proposal,
            rationale: input.rationale,
            evidence: input.evidence,
            status: "proposed",
            validation: null,
            error: null,
            revision: 1,
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
        const row = yield* db
          .select()
          .from(AgentImprovementProposalTable)
          .where(eq(AgentImprovementProposalTable.id, id))
          .get()
          .pipe(Effect.orDie)
        return proposalFromRow(row!)
      }),

      list: Effect.fn("AgentImprovement.list")(function* (rootSessionID: SessionSchema.ID) {
        const rows = yield* db
          .select()
          .from(AgentImprovementProposalTable)
          .where(eq(AgentImprovementProposalTable.root_session_id, rootSessionID))
          .orderBy(AgentImprovementProposalTable.time_created, AgentImprovementProposalTable.id)
          .all()
          .pipe(Effect.orDie)
        return rows.map(proposalFromRow)
      }),

      get: Effect.fn("AgentImprovement.get")(function* (id: ID) {
        return yield* requireProposal(id).pipe(Effect.map(proposalFromRow))
      }),

      adjudicate: Effect.fn("AgentImprovement.adjudicate")(function* (
        id: ID,
        input: { pass: boolean; validation: string },
      ) {
        const current = yield* requireProposal(id)
        if (current.status !== "proposed")
          return yield* new Contract.InvalidState({
            message: `Proposal ${id} cannot be adjudicated from ${current.status}`,
          })
        const now = Date.now()
        const updated = yield* db
          .update(AgentImprovementProposalTable)
          .set({
            status: input.pass ? "validated" : "rejected",
            validation: input.validation,
            revision: current.revision + 1,
            time_updated: now,
          })
          .where(
            and(eq(AgentImprovementProposalTable.id, id), eq(AgentImprovementProposalTable.revision, current.revision)),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updated) return yield* new Contract.Conflict({ message: `Proposal changed concurrently: ${id}` })
        return proposalFromRow(updated)
      }),

      apply: Effect.fn("AgentImprovement.apply")(function* (id: ID) {
        const current = yield* requireProposal(id)
        if (current.status !== "validated")
          return yield* new Contract.InvalidState({
            message: `Proposal ${id} is ${current.status}; only validated proposals can be applied`,
          })
        const now = Date.now()
        const applied = yield* db
          .update(AgentImprovementProposalTable)
          .set({ status: "accepted", revision: current.revision + 1, time_updated: now })
          .where(
            and(
              eq(AgentImprovementProposalTable.id, id),
              eq(AgentImprovementProposalTable.status, "validated"),
              eq(AgentImprovementProposalTable.revision, current.revision),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!applied) return yield* new Contract.Conflict({ message: `Proposal changed concurrently: ${id}` })
        yield* fs
          .writeWithDirs(definitionPath(current.agent), current.proposal_markdown)
          .pipe(
            Effect.mapError(() => new Contract.InvalidState({ message: `Unable to write agent definition: ${id}` })),
          )
        return proposalFromRow(applied)
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentV2.node, Database.node, FSUtil.node, Location.node],
})
