export * as AgentImprovementTool from "./agent-improvement"

import { AgentImprovement as Contract } from "@turenlabs/schema/agent-improvement"
import { ToolFailure } from "@turenlabs/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { AgentImprovement } from "../agent/improvement"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { SessionTaskV2 } from "../session/task"
import { Tool } from "./tool"

export const proposeName = "propose_agent_improvement"
export const adjudicateName = "adjudicate_agent_improvement"
export const applyName = "apply_agent_improvement"

const Definition = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(262_144)))
const Rationale = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(8_192)))
const Evidence = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(131_072)))
const Validation = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(131_072)))

const ProposalView = Schema.Struct({
  proposal_id: Contract.ID,
  agent: AgentV2.ID,
  status: Contract.Status,
  validation: Schema.String.pipe(Schema.optional),
  path: Schema.String.pipe(Schema.optional),
})

const ProposeOutput = Schema.Struct({
  proposal: ProposalView,
  baseline: Schema.String.pipe(Schema.optional),
})

const assertPermission = (
  permission: PermissionV2.Interface,
  action: string,
  resources: ReadonlyArray<string>,
  context: Tool.Context,
) =>
  permission
    .assert({
      action,
      resources,
      sessionID: context.sessionID,
      agent: context.agent,
      source: {
        type: "tool",
        messageID: context.assistantMessageID,
        callID: context.toolCallID,
      },
    })
    .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${action}` })))

const failure = (error: AgentImprovement.Failure) => new ToolFailure({ message: error.message })

const view = (proposal: AgentImprovement.Proposal) => ({
  proposal_id: proposal.id,
  agent: proposal.agent,
  status: proposal.status,
  validation: proposal.validation,
  path: proposal.status === "accepted" ? `${proposal.agent}.md` : undefined,
})

export function makeTools(deps: {
  readonly agentImprovements: AgentImprovement.Interface
  readonly mutations: LocationMutation.Interface
  readonly permission: PermissionV2.Interface
  readonly tasks: SessionTaskV2.Interface
}) {
  const root = (context: Tool.Context) =>
    Effect.gen(function* () {
      const owner = yield* deps.tasks.owner(context.sessionID)
      return owner?.rootSessionID ?? context.sessionID
    })
  const editPermission = (context: Tool.Context, agent: AgentV2.ID, action: string) =>
    Effect.gen(function* () {
      const resolved = yield* deps.mutations
        .resolve({ path: `.forge/agent/${agent}.md`, kind: "file" })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to resolve agent definition: ${agent}.md` })))
      yield* deps.permission
        .assert({
          action,
          resources: [resolved.resource],
          sessionID: context.sessionID,
          agent: context.agent,
          metadata: PermissionV2.mutationMetadata([resolved.canonical]),
          source: {
            type: "tool",
            messageID: context.assistantMessageID,
            callID: context.toolCallID,
          },
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${action}` })))
    })
  return {
    [proposeName]: Tool.make({
      description:
        "Propose an evidence-grounded improvement to an agent definition. Pass failure trace snippets, the proposed replacement definition, and the rationale; the current definition is snapshotted as the baseline. The proposal stays durable and pending until a regression check adjudicates it.",
      input: Schema.Struct({
        agent: AgentV2.ID.annotate({ description: "Agent whose definition would improve" }),
        proposal: Definition.annotate({ description: "Proposed replacement definition" }),
        rationale: Rationale.annotate({ description: "Why the change improves the agent" }),
        evidence: Evidence.annotate({ description: "Failure trace snippets the proposal builds on" }),
      }),
      output: ProposeOutput,
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* assertPermission(deps.permission, proposeName, [input.agent], context)
          const proposed = yield* deps.agentImprovements
            .propose({
              rootSessionID: yield* root(context),
              agent: input.agent,
              authorSessionID: context.sessionID,
              authorAgent: context.agent,
              proposal: input.proposal.trim(),
              rationale: input.rationale,
              evidence: input.evidence,
            })
            .pipe(Effect.mapError(failure))
          return {
            proposal: view(proposed),
            baseline: proposed.baseline,
          }
        }),
    }),
    [adjudicateName]: Tool.make({
      description:
        "Adjudicate a pending improvement proposal with regression-run evidence. A passing validation moves the proposal to validated (apply becomes possible); a failing one rejects it. The validation output is recorded durably with the proposal.",
      input: Schema.Struct({
        proposal_id: Contract.ID,
        pass: Schema.Boolean,
        validation: Validation.annotate({ description: "Regression-run output the decision is grounded in" }),
      }),
      output: Schema.Struct({ proposal: ProposalView }),
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* assertPermission(deps.permission, adjudicateName, [input.proposal_id], context)
          const adjudicated = yield* deps.agentImprovements
            .adjudicate(input.proposal_id, { pass: input.pass, validation: input.validation })
            .pipe(Effect.mapError(failure))
          return { proposal: view(adjudicated) }
        }),
    }),
    [applyName]: Tool.make({
      description:
        "Apply a validated improvement proposal to the agent's workspace definition file. Only proposals that passed a regression check can be applied; the file written is what future runs load.",
      input: Schema.Struct({
        proposal_id: Contract.ID,
      }),
      output: Schema.Struct({ proposal: ProposalView }),
      execute: (input, context) =>
        Effect.gen(function* () {
          const proposal = yield* deps.agentImprovements
            .get(input.proposal_id)
            .pipe(Effect.mapError(() => new ToolFailure({ message: `Proposal not found: ${input.proposal_id}` })))
          yield* editPermission(context, proposal.agent, "edit")
          const applied = yield* deps.agentImprovements.apply(input.proposal_id).pipe(Effect.mapError(failure))
          return { proposal: view(applied) }
        }),
    }),
  } satisfies Readonly<Record<string, Tool.AnyTool>>
}

export interface Interface {
  readonly forExecution: () => Effect.Effect<Readonly<Record<string, Tool.AnyTool>>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/AgentImprovementTool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentImprovements = yield* AgentImprovement.Service
    const mutations = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const tasks = yield* SessionTaskV2.Service
    return Service.of({
      forExecution: () => Effect.succeed(makeTools({ agentImprovements, mutations, permission, tasks })),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentImprovement.node, LocationMutation.node, PermissionV2.node, SessionTaskV2.node],
})
