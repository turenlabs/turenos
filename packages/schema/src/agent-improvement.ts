export * as AgentImprovement from "./agent-improvement"

import { Schema } from "effect"
import { Agent } from "./agent"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, statics } from "./schema"
import { Session } from "./session"

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const boundedNonEmpty = (maximum: number) => Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(maximum)))
const brandID = <B extends string>(brand: B) => boundedNonEmpty(80).pipe(Schema.brand(brand))

/** Full definition text fits a definition file; broader evidence stays bounded but roomy. */
const definitionText = boundedNonEmpty(262_144)
const longText = boundedNonEmpty(131_072)
const noteText = bounded(8_192)

export const ID = brandID("AgentImprovement.ID").pipe(
  statics((schema) => ({ create: () => schema.make("agp_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals(["proposed", "validated", "accepted", "rejected"])
export type Status = typeof Status.Type

export const Proposal = Schema.Struct({
  id: ID,
  rootSessionID: Session.ID,
  agent: Agent.ID,
  authorSessionID: Session.ID,
  authorAgent: Agent.ID,
  /** Snapshot of the definition artifact (or code/config marker) the proposal would replace. */
  baseline: definitionText,
  /** The proposed replacement definition. */
  proposal: definitionText,
  rationale: noteText,
  /** Failure trace snippets the proposal is grounded in. */
  evidence: longText,
  status: Status,
  /** Regression-run output recorded when the proposal passed or failed validation. */
  validation: optional(longText),
  error: optional(noteText),
  revision: NonNegativeInt,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
}).annotate({ identifier: "AgentImprovement.Proposal" })
export interface Proposal extends Schema.Schema.Type<typeof Proposal> {}

export const ProposeInput = Schema.Struct({
  agent: Agent.ID.annotate({ description: "Agent whose definition would improve" }),
  proposal: Schema.NonEmptyString.annotate({ description: "Proposed replacement definition" }),
  rationale: noteText.annotate({ description: "Why the change improves the agent" }),
  evidence: longText.annotate({ description: "Failure trace snippets the proposal builds on" }),
}).annotate({ identifier: "AgentImprovement.ProposeInput" })

export const AdjudicateInput = Schema.Struct({
  proposal_id: ID.annotate({ description: "Proposal to adjudicate" }),
  pass: Schema.Boolean.annotate({ description: "Whether the regression check passed" }),
  validation: longText.annotate({ description: "Regression-run output the decision is grounded in" }),
}).annotate({ identifier: "AgentImprovement.AdjudicateInput" })

export const ApplyInput = Schema.Struct({
  proposal_id: ID.annotate({ description: "Validated proposal to apply" }),
}).annotate({ identifier: "AgentImprovement.ApplyInput" })

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("AgentImprovement.NotFound", {
  resource: Schema.String,
}) {}
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("AgentImprovement.Conflict", {
  message: Schema.String,
}) {}
export class InvalidState extends Schema.TaggedErrorClass<InvalidState>()("AgentImprovement.InvalidState", {
  message: Schema.String,
}) {}
