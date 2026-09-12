import { SessionMessage } from "@turenlabs/schema/session-message"
import { SessionInput } from "@turenlabs/schema/session-input"
import { PromptInput } from "@turenlabs/schema/prompt-input"
import { Session } from "@turenlabs/schema/session"
import { Project } from "@turenlabs/schema/project"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath, statics } from "@turenlabs/schema/schema"
import { Workspace } from "@turenlabs/schema/workspace"
import { Context, Effect, Encoding, Result, Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { Agent } from "@turenlabs/schema/agent"
import { Model } from "@turenlabs/schema/model"
import { Location } from "@turenlabs/schema/location"
import { Revert } from "@turenlabs/schema/revert"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { SessionGoal } from "@turenlabs/schema/session-goal"
import { SessionHarness } from "@turenlabs/schema/session-harness"
import { SessionTerminal } from "@turenlabs/schema/session-terminal"
import { SessionRecovery } from "@turenlabs/schema/session-recovery"
import { SessionTask } from "@turenlabs/schema/session-task"
import { Permission } from "@turenlabs/schema/permission"
import { SwarmRoom } from "@turenlabs/schema/swarm-room"
import { TeamBoard } from "@turenlabs/schema/team-board"
import { Event } from "@turenlabs/schema/event"

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  roots: Schema.Literals(["true", "false"] as const)
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transform((value) => value === "true"),
        encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
      }),
      Schema.optional,
    )
    .annotate({ description: "When true, return only root sessions without a parent session." }),
  archived: Schema.Literals(["true", "false"] as const)
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transform((value) => value === "true"),
        encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
      }),
      Schema.optional,
    )
    .annotate({ description: "Filter sessions by archived state when provided." }),
  internal: Schema.Literal("lobby").pipe(Schema.optional).annotate({
    description: "When lobby, include only internal TurenOS Lobby sessions for local recovery.",
  }),
  inactive: Schema.Literals(["true", "false"] as const)
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transform((value) => value === "true"),
        encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
      }),
      Schema.optional,
    )
    .annotate({ description: "Filter sessions by whether they were last updated more than 48 hours ago." }),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    inactivityThreshold: Schema.Finite.pipe(Schema.optional),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

const SessionHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))
const SessionReplayLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(200))
const SessionReplayQueryText = Schema.String.pipe(Schema.check(Schema.isMaxLength(2_048)))
const SessionReplayFilterField = Schema.Literals([
  "session",
  "id",
  "message",
  "call",
  "type",
  "agent",
  "model",
  "tool",
  "status",
  "path",
  "after",
  "before",
  "has",
  "is",
] as const)
const SessionReplayFilter = Schema.Struct({
  field: SessionReplayFilterField,
  value: Schema.String,
  negated: Schema.Boolean,
}).annotate({ identifier: "SessionReplayFilter" })
const SessionReplayEventMatch = Schema.Struct({
  id: Event.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  timestamp: NonNegativeInt,
  messageID: SessionMessage.ID.pipe(Schema.optional),
  preview: Schema.String,
}).annotate({ identifier: "SessionReplayEventMatch" })
const SessionReplayEntry = Schema.Struct({
  kind: Schema.Literals(["session", "event"] as const),
  session: Session.Info,
  event: SessionReplayEventMatch.pipe(Schema.optional),
  score: Schema.Finite,
}).annotate({ identifier: "SessionReplayEntry" })
export const SessionReplaySearchQuery = Schema.Struct({
  query: SessionReplayQueryText.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionReplayLimit), Schema.optional),
  cursor: Schema.String.pipe(Schema.check(Schema.isMaxLength(256)), Schema.optional),
}).annotate({ identifier: "SessionReplaySearchQuery" })
export const SessionReplaySearchResponse = Schema.Struct({
  data: Schema.Array(SessionReplayEntry),
  total: NonNegativeInt,
  nextCursor: Schema.String.pipe(Schema.optional),
  index: Schema.Struct({
    status: Schema.Literals(["indexing", "ready"] as const),
    progress: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  }),
  parsed: Schema.Struct({
    text: Schema.Array(Schema.String),
    filters: Schema.Array(SessionReplayFilter),
  }),
}).annotate({ identifier: "SessionReplaySearchResponse" })
export const SessionReplayEvent = Schema.Struct({
  id: Event.ID,
  type: Schema.String,
  durable: Schema.Struct({
    aggregateID: Schema.String,
    seq: NonNegativeInt,
    version: NonNegativeInt,
  }),
  data: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "SessionReplayEvent" })
export const SessionReplayHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionReplayLimit), Schema.optional),
  cursor: Event.ID.pipe(Schema.optional),
  anchor: Event.ID.pipe(Schema.optional),
  direction: Schema.Literals(["before", "after"] as const).pipe(Schema.optional),
}).annotate({ identifier: "SessionReplayHistoryQuery" })
export const SessionReplayHistoryResponse = Schema.Struct({
  data: Schema.Array(SessionReplayEvent),
  cursor: Schema.Struct({
    previous: Event.ID.pipe(Schema.optional),
    next: Event.ID.pipe(Schema.optional),
  }),
}).annotate({ identifier: "SessionReplayHistoryResponse" })
const SessionGoalGetResponse = Schema.Struct({
  data: Schema.NullOr(SessionGoal.Info),
}).annotate({
  identifier: "SessionGoalGetResponse",
})
const SessionGoalSetPayload = Schema.Struct({
  id: SessionGoal.ID.pipe(Schema.optional),
  messageID: SessionMessage.ID.pipe(Schema.optional),
  objective: SessionGoal.Objective,
  agent: Agent.ID.pipe(Schema.optional),
  model: Model.Ref.pipe(Schema.optional),
}).annotate({
  identifier: "SessionGoalSetPayload",
})
const SessionGoalEditPayload = Schema.Struct({
  goalID: SessionGoal.ID,
  expectedRevision: SessionGoal.Revision,
  objective: SessionGoal.Objective,
}).annotate({
  identifier: "SessionGoalEditPayload",
})
const SessionGoalStatusPayload = Schema.Struct({
  goalID: SessionGoal.ID,
  expectedRevision: SessionGoal.Revision,
  status: SessionGoal.Status,
}).annotate({
  identifier: "SessionGoalStatusPayload",
})
const SessionGoalClearPayload = Schema.Struct({
  goalID: SessionGoal.ID,
  expectedRevision: SessionGoal.Revision,
}).annotate({
  identifier: "SessionGoalClearPayload",
})
const SessionRevertStagePayload = Schema.Struct({
  messageID: SessionMessage.ID,
  files: Schema.Boolean.pipe(Schema.optional),
}).annotate({
  identifier: "SessionRevertStagePayload",
})
const SessionShellPayload = Schema.Struct({
  id: SessionMessage.ID.pipe(Schema.optional),
  command: Schema.String,
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(600_000)).pipe(Schema.optional),
}).annotate({
  identifier: "SessionShellPayload",
})
const SessionCommandPayload = Schema.Struct({
  id: SessionMessage.ID.pipe(Schema.optional),
  command: Schema.String,
  arguments: Schema.String,
  agent: Agent.ID.pipe(Schema.optional),
  model: Model.Ref.pipe(Schema.optional),
  files: Schema.Array(PromptInput.FileAttachment).pipe(Schema.optional),
  resume: Schema.Boolean.pipe(Schema.optional),
}).annotate({
  identifier: "SessionCommandPayload",
})
const SessionTaskCancelPayload = Schema.Struct({
  expectedRevision: NonNegativeInt.pipe(Schema.optional),
}).annotate({
  identifier: "SessionTaskCancelPayload",
})
const SessionHarnessProposalStatusPayload = SessionHarness.ProposalStatusInput.annotate({
  identifier: "SessionHarnessProposalStatusPayload",
})
const SessionHarnessReloadPayload = SessionHarness.ReloadInput.annotate({
  identifier: "SessionHarnessReloadPayload",
})
const SessionHarnessRollbackPayload = SessionHarness.RollbackInput.annotate({
  identifier: "SessionHarnessRollbackPayload",
})
const SessionTerminalSharePayload = Schema.Struct({ shared: Schema.Boolean }).annotate({
  identifier: "SessionTerminalSharePayload",
})

export const SessionTaskResponseLimits = {
  pageDefault: 25,
  pageMaximum: 100,
  activeMaximum: SessionTask.MAX_ACTIVE_PER_ROOT,
  agentID: SessionTask.MAX_AGENT_ID_LENGTH,
  modelID: SessionTask.MAX_MODEL_ID_LENGTH,
  providerID: SessionTask.MAX_PROVIDER_ID_LENGTH,
  variantID: SessionTask.MAX_VARIANT_ID_LENGTH,
  summaryDescription: SessionTask.MAX_DESCRIPTION_LENGTH,
  summaryResult: 4_000,
  summaryError: 2_000,
  detailDescription: SessionTask.MAX_DESCRIPTION_LENGTH,
  detailPrompt: 65_536,
  detailResult: SessionTask.MAX_RESULT_LENGTH,
  detailError: SessionTask.MAX_ERROR_LENGTH,
  actorToolCallID: SessionTask.MAX_TOOL_CALL_ID_LENGTH,
  permissionRules: 64,
  permissionAction: 256,
  permissionResource: 4_096,
  ancestorPermissionSets: SessionTask.MAX_ANCESTOR_PERMISSION_SETS,
  writeRoots: SessionTask.MAX_WRITE_ROOTS,
  writeRoot: SessionTask.MAX_PATH_LENGTH,
  commands: SessionTask.MAX_COMMANDS,
  command: 4_096,
} as const

const boundedTaskString = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))

export const SessionTaskSummary = Schema.Struct({
  id: SessionTask.ID,
  rootSessionID: Session.ID,
  parentSessionID: Session.ID,
  childSessionID: Session.ID,
  parentTaskID: SessionTask.ID.pipe(Schema.optional),
  agent: Agent.ID,
  model: Model.Ref.pipe(Schema.optional),
  description: boundedTaskString(SessionTaskResponseLimits.summaryDescription),
  depth: NonNegativeInt,
  status: SessionTask.Status,
  revision: NonNegativeInt,
  result: boundedTaskString(SessionTaskResponseLimits.summaryResult).pipe(Schema.optional),
  error: boundedTaskString(SessionTaskResponseLimits.summaryError).pipe(Schema.optional),
  time: SessionTask.Time,
}).annotate({ identifier: "SessionTaskSummary" })

const SessionTaskDetailRule = Schema.Struct({
  action: boundedTaskString(SessionTaskResponseLimits.permissionAction),
  resource: boundedTaskString(SessionTaskResponseLimits.permissionResource),
  effect: Permission.Effect,
}).annotate({ identifier: "SessionTaskDetailRule" })

const SessionTaskDetailRuleset = Schema.Array(SessionTaskDetailRule).pipe(
  Schema.check(Schema.isMaxLength(SessionTaskResponseLimits.permissionRules)),
)

const SessionTaskDetailAuthority = Schema.Struct({
  parentPermissions: SessionTaskDetailRuleset,
  ancestorPermissionSets: Schema.Array(SessionTaskDetailRuleset).pipe(
    Schema.check(Schema.isMaxLength(SessionTaskResponseLimits.ancestorPermissionSets)),
  ),
  childPermissions: SessionTaskDetailRuleset,
  hardPermissions: SessionTaskDetailRuleset,
  writeRoots: Schema.Array(
    AbsolutePath.pipe(Schema.check(Schema.isMaxLength(SessionTaskResponseLimits.writeRoot))),
  ).pipe(Schema.check(Schema.isMaxLength(SessionTaskResponseLimits.writeRoots))),
  commands: Schema.Array(boundedTaskString(SessionTaskResponseLimits.command)).pipe(
    Schema.check(Schema.isMaxLength(SessionTaskResponseLimits.commands)),
  ),
}).annotate({ identifier: "SessionTaskDetailAuthority" })

export const SessionTaskDetail = Schema.Struct({
  id: SessionTask.ID,
  rootSessionID: Session.ID,
  parentSessionID: Session.ID,
  childSessionID: Session.ID,
  parentTaskID: SessionTask.ID.pipe(Schema.optional),
  actor: Schema.Struct({
    sessionID: Session.ID,
    assistantMessageID: SessionMessage.ID,
    toolCallID: boundedTaskString(SessionTaskResponseLimits.actorToolCallID),
  }),
  agent: Agent.ID,
  model: Model.Ref.pipe(Schema.optional),
  prompt: Schema.Struct({
    text: boundedTaskString(SessionTaskResponseLimits.detailPrompt),
  }),
  description: boundedTaskString(SessionTaskResponseLimits.detailDescription),
  depth: NonNegativeInt,
  status: SessionTask.Status,
  revision: NonNegativeInt,
  authority: SessionTaskDetailAuthority,
  result: boundedTaskString(SessionTaskResponseLimits.detailResult).pipe(Schema.optional),
  error: boundedTaskString(SessionTaskResponseLimits.detailError).pipe(Schema.optional),
  time: SessionTask.Time,
}).annotate({ identifier: "SessionTaskDetail" })

const SessionTaskCursorInput = Schema.Struct({
  rootSessionID: Session.ID,
  timeCreated: NonNegativeInt,
  id: SessionTask.ID,
})
const SessionTaskCursorJson = Schema.fromJsonString(SessionTaskCursorInput)
const encodeSessionTaskCursor = Schema.encodeSync(SessionTaskCursorJson)
const decodeSessionTaskCursor = Schema.decodeUnknownEffect(SessionTaskCursorJson)

export const SessionTaskCursor = Schema.String.pipe(
  Schema.brand("SessionTaskCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionTaskCursorInput.Type) =>
        make(Encoding.encodeBase64Url(encodeSessionTaskCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionTaskCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionTaskCursor = typeof SessionTaskCursor.Type

const SessionTaskPageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(SessionTaskResponseLimits.pageMaximum))

export const SessionTaskListQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionTaskPageLimit), Schema.optional),
  cursor: SessionTaskCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionTaskListQuery" })

export const SessionHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

export const SessionOutboxQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionHistoryLimit), Schema.optional),
  cursor: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
  status: SessionInput.Status.pipe(Schema.optional),
})

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
          summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.replay", "/api/session/replay", {
        query: SessionReplaySearchQuery,
        success: SessionReplaySearchResponse,
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.replay",
          summary: "Search the session replay index",
          description:
            "Search session metadata and durable replay events. Free text uses FTS5; filters include session, id, message, call, type, agent, model, tool, status, path, after, before, has:error, and is:session|event. Prefix a filter with - to negate it.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this TurenOS process. Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.interruptAll", "/api/session/interrupt-all", {
        success: Schema.Struct({
          data: Schema.Struct({ interrupted: NonNegativeInt, failed: NonNegativeInt }),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.interruptAll",
          summary: "Interrupt all session execution",
          description:
            "Snapshot active Session execution owned by this TurenOS process, resolve task-owned Sessions to their roots, and wait for every root cancellation cascade to settle. The response reports both successful and failed root cascades.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.terminal.get", "/api/session/:sessionID/terminal", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.NullOr(SessionTerminal.State) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.terminal.get",
            summary: "Get the shared terminal",
            description: "Retrieve the interactive PTY bound to this session, if one exists.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.terminal.create", "/api/session/:sessionID/terminal", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SessionTerminal.State }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.terminal.create",
            summary: "Open the shared terminal",
            description: "Create or return the single interactive PTY shared by the human and agent for this session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.terminal.share", "/api/session/:sessionID/terminal/share", {
        params: { sessionID: Session.ID },
        payload: SessionTerminalSharePayload,
        success: Schema.Struct({ data: SessionTerminal.State }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.terminal.share",
            summary: "Set shared terminal access",
            description: "Allow or prevent the session agent from interacting with the human terminal.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.terminal.remove", "/api/session/:sessionID/terminal", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.terminal.remove",
            summary: "Close the shared terminal",
            description: "Terminate and remove the interactive PTY bound to this session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.harness.state", "/api/session/:sessionID/harness", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SessionHarness.State }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.state",
            summary: "Get session harness state",
            description: "Retrieve the current declarative harness snapshot and proposals for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.harness.proposal", "/api/session/:sessionID/harness/proposal", {
        params: { sessionID: Session.ID },
        payload: SessionHarness.ProposalInput,
        success: Schema.Struct({ data: SessionHarness.HarnessProposal }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.proposal",
            summary: "Create harness proposal",
            description: "Record a declarative harness proposal against a session snapshot version.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "session.harness.proposalStatus",
        "/api/session/:sessionID/harness/proposal/:proposalID/status",
        {
          params: { sessionID: Session.ID, proposalID: SessionHarness.ProposalID },
          payload: SessionHarnessProposalStatusPayload,
          success: Schema.Struct({ data: SessionHarness.HarnessProposal }),
          error: [ConflictError, InvalidRequestError, SessionNotFoundError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.proposal.status",
            summary: "Update harness proposal status",
            description: "Change the lifecycle status of a declarative harness proposal.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "session.harness.proposalApply",
        "/api/session/:sessionID/harness/proposal/:proposalID/apply",
        {
          params: { sessionID: Session.ID, proposalID: SessionHarness.ProposalID },
          success: Schema.Struct({ data: SessionHarness.HarnessSnapshot }),
          error: [ConflictError, InvalidRequestError, SessionNotFoundError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.proposal.apply",
            summary: "Apply harness proposal",
            description: "Apply an accepted declarative harness proposal to create a new session snapshot.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "session.harness.proposalReject",
        "/api/session/:sessionID/harness/proposal/:proposalID/reject",
        {
          params: { sessionID: Session.ID, proposalID: SessionHarness.ProposalID },
          success: Schema.Struct({ data: SessionHarness.HarnessProposal }),
          error: [ConflictError, InvalidRequestError, SessionNotFoundError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.proposal.reject",
            summary: "Reject harness proposal",
            description: "Reject a declarative harness proposal without changing the active snapshot.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.harness.reload", "/api/session/:sessionID/harness/reload", {
        params: { sessionID: Session.ID },
        payload: SessionHarnessReloadPayload,
        success: Schema.Struct({ data: SessionHarness.HarnessSnapshot }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.reload",
            summary: "Reload session harness",
            description: "Reload the declarative harness state for a session and record the resulting snapshot.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.harness.rollback", "/api/session/:sessionID/harness/rollback", {
        params: { sessionID: Session.ID },
        payload: SessionHarnessRollbackPayload,
        success: Schema.Struct({ data: SessionHarness.HarnessSnapshot }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.harness.rollback",
            summary: "Rollback session harness",
            description: "Restore a prior declarative harness snapshot for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: [InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: [InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          prompt: PromptInput.Prompt,
          delivery: SessionInput.Delivery.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: SessionShellPayload,
        success: Schema.Struct({ data: SessionMessage.Shell }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.shell",
            summary: "Run a shell command",
            description:
              "Run one bounded shell command at the Session location and durably reconcile an exact retry by message ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: SessionCommandPayload,
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.command",
            summary: "Run a custom command",
            description:
              "Resolve one configured custom command into a durable prompt and reconcile exact retries by message ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.resume", "/api/session/:sessionID/resume", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SessionRecovery.Outcome }),
        error: [InvalidRequestError, ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.resume",
            summary: "Schedule session execution",
            description:
              "Recover an interrupted durable turn without replaying it, report whether already-admitted work was scheduled, or schedule a safe advisory wake without joining the drain.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.goalGet", "/api/session/:sessionID/goal", {
        params: { sessionID: Session.ID },
        success: SessionGoalGetResponse,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.get",
            summary: "Get session goal",
            description: "Retrieve the current durable goal, including loop usage and lifecycle state.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.goalSet", "/api/session/:sessionID/goal", {
        params: { sessionID: Session.ID },
        payload: SessionGoalSetPayload,
        success: Schema.Struct({ data: SessionGoal.Info }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.set",
            summary: "Set session goal",
            description:
              "Create a durable goal, atomically admit its first objective prompt, then schedule agent-loop execution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("session.goalEdit", "/api/session/:sessionID/goal", {
        params: { sessionID: Session.ID },
        payload: SessionGoalEditPayload,
        success: Schema.Struct({ data: SessionGoal.Info }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.edit",
            summary: "Edit session goal",
            description: "Edit the current goal with an opaque identity and revision guard.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.goalStatus", "/api/session/:sessionID/goal/status", {
        params: { sessionID: Session.ID },
        payload: SessionGoalStatusPayload,
        success: Schema.Struct({ data: SessionGoal.Info }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.status",
            summary: "Update session goal status",
            description:
              "Persist a goal lifecycle transition. Activating schedules execution; other states interrupt after persistence.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.goalClear", "/api/session/:sessionID/goal", {
        params: { sessionID: Session.ID },
        payload: SessionGoalClearPayload,
        success: HttpApiSchema.NoContent,
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.clear",
            summary: "Clear session goal",
            description: "Clear the guarded current goal and interrupt local execution after the clear is durable.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.taskList", "/api/session/:sessionID/task", {
        params: { sessionID: Session.ID },
        query: SessionTaskListQuery,
        success: Schema.Struct({
          data: Schema.Array(SessionTaskSummary),
          active: Schema.Array(SessionTaskSummary).pipe(
            Schema.check(Schema.isMaxLength(SessionTaskResponseLimits.activeMaximum)),
          ),
          cursor: Schema.Struct({
            next: SessionTaskCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionTaskListResponse" }),
        error: [InvalidCursorError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.task.list",
            summary: "List durable subagent tasks",
            description:
              "List bounded task summaries newest first. Summary pages never include prompts or authority policy.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.taskGet", "/api/session/:sessionID/task/:taskID", {
        params: { sessionID: Session.ID, taskID: SessionTask.ID },
        success: Schema.Struct({ data: SessionTaskDetail }).annotate({
          identifier: "SessionTaskGetResponse",
        }),
        error: [InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.task.get",
            summary: "Get durable subagent task",
            description: "Retrieve one bounded durable subagent task detail owned by the selected Session tree.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.taskCancel", "/api/session/:sessionID/task/:taskID/cancel", {
        params: { sessionID: Session.ID, taskID: SessionTask.ID },
        payload: SessionTaskCancelPayload,
        success: Schema.Struct({ data: SessionTaskDetail }).annotate({
          identifier: "SessionTaskCancelResponse",
        }),
        error: [ConflictError, InvalidRequestError, ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.task.cancel",
            summary: "Cancel durable subagent task",
            description:
              "Wait for local execution to stop before committing durable task cancellation. A timeout fails without reporting the task cancelled.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.teamBoard", "/api/session/:sessionID/team-board", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: TeamBoard.BoardState }).annotate({
          identifier: "SessionTeamBoardResponse",
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.team_board",
            summary: "Get the subagent team board",
            description: "Retrieve the durable communication board shared by a Session and its subagents.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.swarmRoom", "/api/session/:sessionID/room", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SwarmRoom.State }).annotate({
          identifier: "SessionSwarmRoomResponse",
        }),
        error: [SessionNotFoundError, SwarmRoom.NotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.swarm_room",
            summary: "Get the swarm room",
            description:
              "Retrieve the swarm room shared by a Session and its subagents: objective, members, lane claims, and head.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.swarmRoomEntries", "/api/session/:sessionID/room/entries", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
          limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
        }),
        success: Schema.Struct({ data: SwarmRoom.EntryPage }).annotate({
          identifier: "SessionSwarmRoomEntriesResponse",
        }),
        error: [SessionNotFoundError, SwarmRoom.NotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.swarm_room_entries",
            summary: "List swarm room entries",
            description:
              "Retrieve room entries sequenced after `after`. The room's head is the compare-and-swap cursor for coordination writes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.swarmRoomPost", "/api/session/:sessionID/room/entries", {
        params: { sessionID: Session.ID },
        payload: SwarmRoom.HumanPostInput,
        success: Schema.Struct({ data: SwarmRoom.Entry }).annotate({
          identifier: "SessionSwarmRoomPostResponse",
        }),
        error: [
          SessionNotFoundError,
          SwarmRoom.NotFoundError,
          SwarmRoom.ConflictError,
          SwarmRoom.InvalidStateError,
          SwarmRoom.ForbiddenError,
        ],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.swarm_room_post",
            summary: "Post a human message to the swarm room",
            description:
              "Post a human-authored entry to a Session's swarm room. Agent members are notified through their durable input queue.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description: "Compact a session conversation.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for session",
            description: "Wait for a session agent loop to become idle.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: SessionRevertStagePayload,
        success: Schema.Struct({ data: Revert.State }),
        error: [InvalidRequestError, MessageNotFoundError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [InvalidRequestError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
        error: [InvalidRequestError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.context",
            summary: "Get session context",
            description: "Retrieve the active context messages for a session (all messages after the last compaction).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.pendingInputs", "/api/session/:sessionID/input", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionInput.Admitted) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.pendingInputs",
            summary: "Get pending session inputs",
            description:
              "Retrieve durable admitted inputs that have not yet been promoted into the projected transcript.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.inputStatus", "/api/session/:sessionID/input/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionInput.OutboxItem.pipe(Schema.optional) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.inputStatus",
            summary: "Get durable session input status",
            description: "Retrieve one admitted, promoted, or cancelled input by its stable message ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.outbox", "/api/session/:sessionID/outbox", {
        params: { sessionID: Session.ID },
        query: SessionOutboxQuery,
        success: Schema.Struct({
          data: Schema.Array(SessionInput.OutboxItem),
          next: NonNegativeInt.pipe(Schema.optional),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.outbox",
            summary: "List durable session input lifecycle",
            description: "List admitted, promoted, and cancelled inputs in admission order.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.history", "/api/session/:sessionID/history", {
        params: { sessionID: Session.ID },
        query: SessionHistoryQuery,
        success: Schema.Struct({
          data: Schema.Array(SessionEvent.Durable),
          hasMore: Schema.Boolean,
          latest: Schema.Int.annotate({
            description: "Latest committed aggregate sequence, or -1 when the session has no durable events.",
          }),
        }).annotate({ identifier: "SessionHistory" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.history",
            summary: "Get session history",
            description:
              "Read one finite page of public durable Session events after an exclusive aggregate sequence. Newly committed events may appear on later pages.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.replayHistory", "/api/session/:sessionID/replay", {
        params: { sessionID: Session.ID },
        query: SessionReplayHistoryQuery,
        success: SessionReplayHistoryResponse,
        error: [InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.replayHistory",
            summary: "Read the complete session debug stream",
            description:
              "Read durable root-session events together with linked task aggregate events in deterministic timestamp and aggregate order. Unlike public session history, this includes legacy creation/message records for debugging.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.events", "/api/session/:sessionID/event", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
        },
        success: HttpApiSchema.StreamSse({ data: SessionEvent.Durable }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.events",
            summary: "Subscribe to session events",
            description: "Replay durable events after an aggregate sequence, then continue with new durable events.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [ConflictError, InvalidRequestError, ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.interrupt",
            summary: "Interrupt session execution",
            description:
              "Wait for owned subagent execution to stop before committing durable cancellation, then interrupt active execution owned by this TurenOS process. A timeout fails without reporting still-running tasks cancelled.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionMessage.Message }),
        error: [InvalidRequestError, SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.message",
            summary: "Get session message",
            description: "Retrieve one projected message owned by the Session.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessions",
        description: "Experimental session routes.",
      }),
    )
