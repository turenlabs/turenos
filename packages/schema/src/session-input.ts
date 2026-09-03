export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Model } from "./model"
import { PromptInput } from "./prompt-input"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export const Status = Schema.Literals(["admitted", "promoted", "cancelled"])
export type Status = typeof Status.Type

/** Durable origin used for advisory inbox coalescing and recovery. */
export const Source = Schema.Literals(["user", "subagent_board"])
export type Source = typeof Source.Type

export interface CommandIntent extends Schema.Schema.Type<typeof CommandIntent> {}
export const CommandIntent = Schema.Struct({
  command: Schema.String,
  arguments: Schema.String,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  files: Schema.Array(PromptInput.FileAttachment).pipe(optional),
}).annotate({ identifier: "SessionInput.CommandIntent" })

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })

export interface OutboxItem extends Schema.Schema.Type<typeof OutboxItem> {}
export const OutboxItem = Schema.Struct({
  ...Admitted.fields,
  status: Status,
  timeCancelled: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "SessionInput.OutboxItem" })
