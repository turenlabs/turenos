export * as SessionRunner from "./index"

import type { LLMError } from "@turenlabs/llm"
import { Context, Effect } from "effect"
import { SessionSchema } from "../schema"
import type { SessionExecutionControl } from "../execution-control"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import type { SessionCompaction } from "../compaction"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { ToolOutputStore } from "../../tool-output-store"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error

/**
 * Manual compaction reports every way it can decline. It shares no failure modes with `run`
 * beyond model resolution and transcript decoding -- a summary that never materialises is a
 * `SessionCompaction.FailedError`, not a silent success.
 */
export type CompactError = SessionCompaction.FailedError | SessionRunnerModel.Error | MessageDecodeError

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    readonly control: SessionExecutionControl.Interface
  }) => Effect.Effect<void, RunError>
  /** Compacts on demand, ignoring `compaction.auto` and the context budget. Fails loudly. */
  readonly compact: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<void, CompactError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionRunner") {}
