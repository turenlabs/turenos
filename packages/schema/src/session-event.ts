export * as SessionEvent from "./session-event"

import { Schema } from "effect"
import { Agent } from "./agent"
import { optional } from "./schema"
import { Event } from "./event"
import { ProviderMetadata, ToolContent } from "./llm"
import { Delivery } from "./session-delivery"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, RelativePath } from "./schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionID } from "./session-id"
import { Location } from "./location"
import { SessionMessage } from "./session-message"
import { SessionGoal } from "./session-goal"
import { SessionHarness } from "./session-harness"
import { SessionInput } from "./session-input"
import { SessionTask } from "./session-task"
import { Revert } from "./revert"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}
const PromptFields = {
  ...Base,
  messageID: SessionMessage.ID,
  prompt: Prompt,
  delivery: Delivery,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

export const UnknownError = SessionMessage.UnknownError
export type UnknownError = SessionMessage.UnknownError

export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    model: Model.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

/**
 * Renames a Session. Deliberately a delta and not a `session.updated` snapshot: the only durable
 * title writer before this was V1's coarse whole-`SessionInfo` event, whose projection rewrites
 * every session column from the payload. A rename built that way has to read the row first, so it
 * races the cost, token, revert and compaction columns the running turn is updating underneath it.
 * A title is one field; say so, and let the projector touch one column.
 */
export const TitleUpdated = Event.define({
  type: "session.next.title.updated",
  ...options,
  schema: {
    ...Base,
    title: Schema.String,
  },
})
export type TitleUpdated = typeof TitleUpdated.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(optional),
  },
})
export type Moved = typeof Moved.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...options,
  schema: PromptFields,
})
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = Event.define({
  type: "session.next.prompt.admitted",
  ...options,
  schema: {
    ...PromptFields,
    source: SessionInput.Source.pipe(optional),
    agent: Agent.ID.pipe(optional),
    model: Model.Ref.pipe(optional),
    command: SessionInput.CommandIntent.pipe(optional),
    revert: Schema.Struct({ messageID: SessionMessage.ID }).pipe(optional),
  },
})
export type PromptAdmitted = typeof PromptAdmitted.Type

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      callID: Schema.String,
      command: Schema.String,
      timeout: Schema.Int.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
      status: Schema.Literals(["completed", "cancelled", "timed_out", "failed"]),
      exitCode: Schema.Int.pipe(optional),
      truncated: Schema.Boolean.pipe(optional),
      error: Schema.String.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  /**
   * Not annotated, and deliberately not hoisted into an exported schema: the two
   * fields below must keep the exact structural shape `tokens` already has on the
   * wire, so this is a shared literal and nothing more.
   */
  const Tokens = Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  })

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      finish: Schema.String,
      /**
       * What this turn cost, in dollars. Cumulative by nature -- priced off
       * {@link Ended.billed}, never off `tokens`. Zero when the model has no
       * per-token pricing (a subscription-billed transport such as the Claude
       * Code CLI, whose catalog entry carries an empty `cost` array).
       */
      cost: Schema.Finite,
      /**
       * Context *occupancy*: what the model's context window held as of this
       * turn's last provider request. A property of one request, so it is the
       * right input to "how full is the window" and to per-request price tier
       * selection -- and the wrong input to anything cumulative. Summing it
       * across a session is the bug that once reported 822% of a 200K window,
       * because cache reads occupy the window but recur on every request.
       */
      tokens: Tokens,
      /**
       * Everything the turn actually processed, and therefore everything that
       * was charged for. Equal to `tokens` for the providers where one TurenOS
       * turn is exactly one provider request; larger for transports that run
       * their own agentic loop behind a single turn (the Claude Code CLI),
       * where `tokens` describes only the final round trip.
       *
       * Optional because `Step.Ended` v2 events were persisted before this
       * field existed; readers fall back to `tokens`, which is exact for every
       * single-request provider and an undercount only for the looping ones.
       * Adding an optional field keeps those rows decodable -- bumping the
       * durable version instead would orphan them, since the stored `type`
       * column embeds the version and the manifest is keyed by it.
       */
      billed: Tokens.pipe(optional),
      /**
       * The model this turn ran on -- the same ref its {@link Started}
       * published, carried here so a usage report can attribute a settled turn
       * to a provider without joining back to the step that opened it.
       *
       * Optional for the same reason `billed` is: `Step.Ended` v2 events were
       * persisted before this field existed, and bumping the durable version to
       * make it required would orphan them, since the stored `type` column
       * embeds the version and the manifest is keyed by it. Readers fall back to
       * joining `Step.Started` on `assistantMessageID`.
       */
      model: Model.Ref.pipe(optional),
      snapshot: Schema.String.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
      outputPaths: Schema.Array(Schema.String).pipe(optional),
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: UnknownError,
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Harness {
  export const ProposalCreated = Event.define({
    type: "session.next.harness.proposal.created",
    ...options,
    schema: {
      ...Base,
      proposal: SessionHarness.HarnessProposal,
    },
  })
  export type ProposalCreated = typeof ProposalCreated.Type

  export const ProposalStatus = Event.define({
    type: "session.next.harness.proposal.status",
    ...options,
    schema: {
      ...Base,
      proposalID: SessionHarness.ProposalID,
      status: SessionHarness.ProposalStatus,
      validation: SessionHarness.Validation.pipe(optional),
    },
  })
  export type ProposalStatus = typeof ProposalStatus.Type

  export const SnapshotCreated = Event.define({
    type: "session.next.harness.snapshot.created",
    ...options,
    schema: {
      ...Base,
      proposalID: SessionHarness.ProposalID.pipe(optional),
      snapshot: SessionHarness.HarnessSnapshot,
    },
  })
  export type SnapshotCreated = typeof SnapshotCreated.Type

  export const Reloaded = Event.define({
    type: "session.next.harness.reloaded",
    ...options,
    schema: {
      ...Base,
      version: SessionHarness.Version,
    },
  })
  export type Reloaded = typeof Reloaded.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(optional),
  responseBody: Schema.String.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export interface RetryError extends Schema.Schema.Type<typeof RetryError> {}

/**
 * Client-visible call to action for a retry the user can do something about --
 * a quota that needs topping up, an account that needs upgrading. Same shape as
 * V1's `SessionStatusEvent.Info` retry action so the desktop can render either
 * source through one component.
 */
export const RetryAction = Schema.Struct({
  reason: Schema.String,
  provider: Schema.String,
  title: Schema.String,
  message: Schema.String,
  label: Schema.String,
  link: Schema.String.pipe(optional),
}).annotate({
  identifier: "session.next.retry_action",
})
export interface RetryAction extends Schema.Schema.Type<typeof RetryAction> {}

/**
 * One provider attempt failed retryably and the next one is scheduled.
 *
 * `delay` is relative to `timestamp` rather than an absolute deadline so replay
 * of a durable log stays meaningful: readers that want V1's absolute `next`
 * compute `timestamp + delay`, and a log replayed on another machine does not
 * claim a wall-clock instant that never existed there.
 */
export const Retried = Event.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    delay: NonNegativeInt,
    error: RetryError,
    action: RetryAction.pipe(optional),
  },
})
export type Retried = typeof Retried.Type

export namespace Compaction {
  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
      /**
       * The whole append-only fact ledger as of this checkpoint, oldest line first.
       *
       * Carried in full rather than as a delta so the projection stays a pure function of the
       * newest `Ended` event: a checkpoint is replaced, never merged, and a reader that missed an
       * earlier event still reconstructs the exact ledger the model was shown. Absent on every
       * event written before the ledger landed, and absent on a compaction whose extraction
       * produced nothing.
       */
      ledger: Schema.Array(Schema.String).pipe(optional),
      throughSeq: NonNegativeInt.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  /** A started compaction that did not advance the active history boundary. */
  export const Failed = Event.define({
    type: "session.next.compaction.failed",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      mode: Started.data.fields.reason,
      reason: Schema.String,
      /**
       * What the provider actually said, when a provider is what failed.
       *
       * `reason` is a closed vocabulary, and `providerFailed` covers everything from an expired
       * key to a prompt the provider rejected as an oversized string -- distinctions the user has
       * to know to act on. Without this the only record was a log line that did not include the
       * provider's message at all, so a permanently uncompactable session took a database
       * forensics session to explain. Absent on failures that have no provider message.
       */
      detail: Schema.String.pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type

  /**
   * Durable record of tool output cleared from the model's view.
   *
   * Prune itself is a read-time transform (`core/session/compaction.ts`), so without this the
   * desktop transcript renders a 200k-character tool result while the model sees a 33-character
   * sentinel and the user has no signal that the two diverged. The projection marks
   * `time.pruned` on the named parts; it never clears their stored content, so history stays
   * readable and prune stays free to re-derive the same decision on the next turn.
   */
  export const Pruned = Event.define({
    type: "session.next.compaction.pruned",
    ...options,
    schema: {
      ...Base,
      entries: Schema.Array(
        Schema.Struct({
          assistantMessageID: SessionMessage.ID,
          callID: Schema.String,
        }),
      ),
      /** Estimated tokens the pass reclaimed. Diagnostic only -- nothing projects it. */
      freed: NonNegativeInt,
    },
  })
  export type Pruned = typeof Pruned.Type
}

export namespace RevertEvent {
  export const Staged = Event.define({
    type: "session.next.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert.State },
  })
  export const Cleared = Event.define({ type: "session.next.revert.cleared", ...options, schema: Base })
  export const Committed = Event.define({
    type: "session.next.revert.committed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID },
  })
}

export namespace Goal {
  export const Updated = Event.define({
    type: "session.next.goal.updated",
    ...options,
    schema: {
      ...Base,
      goal: SessionGoal.Info,
      activeTimeMs: NonNegativeInt,
      admission: Schema.Struct({
        messageID: SessionMessage.ID,
        prompt: Prompt,
        delivery: Delivery,
        agent: Agent.ID.pipe(optional),
        model: Model.Ref.pipe(optional),
        revert: Schema.Struct({ messageID: SessionMessage.ID }).pipe(optional),
      }).pipe(optional),
    },
  })
  export type Updated = typeof Updated.Type

  export const Cleared = Event.define({
    type: "session.next.goal.cleared",
    ...options,
    schema: {
      ...Base,
      goalID: SessionGoal.ID,
      revision: SessionGoal.Revision,
    },
  })
  export type Cleared = typeof Cleared.Type
}

export namespace Task {
  export const Updated = Event.define({
    type: "session.next.task.updated",
    durable: {
      aggregate: "taskID",
      version: 1,
    },
    schema: {
      ...Base,
      taskID: SessionTask.ID,
      task: SessionTask.Info,
      operation: SessionTask.Operation.pipe(optional),
    },
  })
  export type Updated = typeof Updated.Type

  export const OperationUpdated = Event.define({
    type: "session.next.task.operation.updated",
    durable: {
      aggregate: "taskID",
      version: 1,
    },
    schema: {
      ...Base,
      taskID: SessionTask.ID,
      operation: SessionTask.Operation,
    },
  })
  export type OperationUpdated = typeof OperationUpdated.Type
}

export const DurableDefinitions = Event.inventory(
  AgentSwitched,
  ModelSwitched,
  TitleUpdated,
  Moved,
  Prompted,
  PromptAdmitted,
  ContextUpdated,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Harness.ProposalCreated,
  Harness.ProposalStatus,
  Harness.SnapshotCreated,
  Harness.Reloaded,
  Retried,
  Compaction.Started,
  Compaction.Ended,
  Compaction.Failed,
  Compaction.Pruned,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
  Goal.Updated,
  Goal.Cleared,
  Task.Updated,
  Task.OperationUpdated,
)

export const Definitions = Event.inventory(
  AgentSwitched,
  ModelSwitched,
  TitleUpdated,
  Moved,
  Prompted,
  PromptAdmitted,
  ContextUpdated,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Harness.ProposalCreated,
  Harness.ProposalStatus,
  Harness.SnapshotCreated,
  Harness.Reloaded,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Retried,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  Compaction.Failed,
  Compaction.Pruned,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
  Goal.Updated,
  Goal.Cleared,
  Task.Updated,
  Task.OperationUpdated,
)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
