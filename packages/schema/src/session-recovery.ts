export * as SessionRecovery from "./session-recovery"

import { Schema } from "effect"
import { SessionMessage } from "./session-message"

export const Scheduled = Schema.Struct({
  status: Schema.Literal("scheduled"),
}).annotate({ identifier: "SessionRecovery.Scheduled" })
export interface Scheduled extends Schema.Schema.Type<typeof Scheduled> {}

export const Running = Schema.Struct({
  status: Schema.Literal("running"),
}).annotate({ identifier: "SessionRecovery.Running" })
export interface Running extends Schema.Schema.Type<typeof Running> {}

export const Interrupted = Schema.Struct({
  status: Schema.Literal("interrupted"),
  assistantMessageID: SessionMessage.ID,
  reason: Schema.String,
  next: Schema.Literals(["scheduled", "idle"]),
}).annotate({ identifier: "SessionRecovery.Interrupted" })
export interface Interrupted extends Schema.Schema.Type<typeof Interrupted> {}

export const ShellInterrupted = Schema.Struct({
  status: Schema.Literal("interrupted"),
  shellMessageID: SessionMessage.ID,
  reason: Schema.String,
  next: Schema.Literals(["scheduled", "idle"]),
}).annotate({ identifier: "SessionRecovery.ShellInterrupted" })
export interface ShellInterrupted extends Schema.Schema.Type<typeof ShellInterrupted> {}

export const Idle = Schema.Struct({
  status: Schema.Literal("idle"),
}).annotate({ identifier: "SessionRecovery.Idle" })
export interface Idle extends Schema.Schema.Type<typeof Idle> {}

export const Outcome = Schema.Union([Scheduled, Running, Interrupted, ShellInterrupted, Idle]).annotate({
  identifier: "SessionRecovery.Outcome",
})
export type Outcome = typeof Outcome.Type
