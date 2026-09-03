export * as TeamBoard from "./team-board"

import { Schema } from "effect"
import { Agent } from "./agent"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, statics } from "./schema"
import { Session } from "./session"

export const postToolName = "board_post"
export const readToolName = "board_read"
export const toolActions = [postToolName, readToolName] as const

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const boundedNonEmpty = (maximum: number) => Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(maximum)))
const brandID = <B extends string>(brand: B) => boundedNonEmpty(80).pipe(Schema.brand(brand))

const longText = boundedNonEmpty(131_072)
const evidenceText = bounded(131_072)
const titleText = boundedNonEmpty(256)

export const ID = brandID("TeamBoard.NoteID").pipe(
  statics((schema) => ({ create: () => schema.make("tbn_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * `correction` and `refuted` are what make the board a conversation rather than a log: a sibling
 * uses them to overturn a teammate's claim with better evidence instead of silently disagreeing.
 */
export const Kind = Schema.Literals(["finding", "correction", "lead", "refuted", "capability", "status"])
export type Kind = typeof Kind.Type

export const Note = Schema.Struct({
  id: ID,
  /** The team a note belongs to: the root Session shared by every sibling on the run. */
  rootSessionID: Session.ID,
  authorSessionID: Session.ID,
  authorAgent: Agent.ID,
  kind: Kind,
  title: titleText,
  body: longText,
  /** What the author actually observed, so a sibling can verify the claim instead of trusting it. */
  evidence: evidenceText.pipe(optional),
  supersedes: ID.pipe(optional),
  supersededBy: ID.pipe(optional),
  revision: NonNegativeInt,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
}).annotate({ identifier: "TeamBoard.Note" })
export interface Note extends Schema.Schema.Type<typeof Note> {}

export const PostInput = Schema.Struct({
  kind: Kind.annotate({
    description: "What this note is: a finding, correction, lead, refutation, capability, or status",
  }),
  title: titleText.annotate({ description: "One line a teammate can scan" }),
  body: longText.annotate({ description: "The substance of the note" }),
  evidence: evidenceText.pipe(optional).annotate({ description: "Observed evidence backing the claim" }),
  supersedes: ID.pipe(optional).annotate({ description: "Note this one corrects and replaces" }),
}).annotate({ identifier: "TeamBoard.PostInput" })

export const BoardState = Schema.Struct({
  notes: Schema.Array(Note),
}).annotate({ identifier: "TeamBoard.BoardState" })
export interface BoardState extends Schema.Schema.Type<typeof BoardState> {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("TeamBoard.NotFound", {
  resource: Schema.String,
}) {}
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("TeamBoard.Conflict", {
  message: Schema.String,
}) {}
export class InvalidState extends Schema.TaggedErrorClass<InvalidState>()("TeamBoard.InvalidState", {
  message: Schema.String,
}) {}
