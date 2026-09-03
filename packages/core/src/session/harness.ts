export * as SessionHarness from "./harness"

import { SessionHarness } from "@turenlabs/schema/session-harness"
import { CodeMode } from "@turenlabs/codemode"
import { ToolFailure } from "@turenlabs/llm"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { and, eq } from "drizzle-orm"
import { Cause, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionStore } from "./store"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionHarnessTable } from "./sql"
import { Tool } from "../tool/tool"
import { PermissionV2 } from "../permission"

export const ProposalID = SessionHarness.ProposalID
export type ProposalID = SessionHarness.ProposalID
export const Version = SessionHarness.Version
export type Version = SessionHarness.Version
export const ProposalStatus = SessionHarness.ProposalStatus
export type ProposalStatus = SessionHarness.ProposalStatus
export const Snapshot = SessionHarness.HarnessSnapshot
export type Snapshot = SessionHarness.HarnessSnapshot
export const Proposal = SessionHarness.HarnessProposal
export type Proposal = SessionHarness.HarnessProposal
export const Guidance = SessionHarness.HarnessGuidance
export type Guidance = SessionHarness.HarnessGuidance
export const ReviewerRequest = SessionHarness.ReviewerRequest
export type ReviewerRequest = SessionHarness.ReviewerRequest
export const ReviewerRun = SessionHarness.ReviewerRun
export type ReviewerRun = SessionHarness.ReviewerRun
export const ReviewerRunOutcome = SessionHarness.ReviewerRunOutcome
export type ReviewerRunOutcome = SessionHarness.ReviewerRunOutcome
export const State = SessionHarness.State
export type State = SessionHarness.State

const HARNESS_TOOL_TIMEOUT_MS = 1_000
const HARNESS_TOOL_OUTPUT_BYTES = 64 * 1024
export const REVIEW_REQUEST_TOOL_NAME = "harness_review_request"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionHarness.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class ProposalNotFoundError extends Schema.TaggedErrorClass<ProposalNotFoundError>()(
  "SessionHarness.ProposalNotFoundError",
  {
    sessionID: SessionSchema.ID,
    proposalID: SessionHarness.ProposalID,
  },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionHarness.ConflictError", {
  sessionID: SessionSchema.ID,
  proposalID: Schema.optional(SessionHarness.ProposalID),
  message: Schema.String,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()(
  "SessionHarness.InvalidStateError",
  {
    sessionID: SessionSchema.ID,
    proposalID: Schema.optional(SessionHarness.ProposalID),
    message: Schema.String,
  },
) {}

export type Error = NotFoundError | ProposalNotFoundError | ConflictError | InvalidStateError

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly peek: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly request: (
    input: ReviewerRequestInput,
  ) => Effect.Effect<ReviewerRequest, NotFoundError | ConflictError | InvalidStateError>
  readonly recordRun: (input: ReviewerRunInput) => Effect.Effect<void>
  readonly propose: (input: ProposalInput) => Effect.Effect<Proposal, NotFoundError | ConflictError | InvalidStateError>
  readonly status: (
    input: ProposalStatusInput,
  ) => Effect.Effect<Proposal, NotFoundError | ProposalNotFoundError | ConflictError | InvalidStateError>
  readonly apply: (
    input: ProposalReference,
  ) => Effect.Effect<Snapshot, NotFoundError | ProposalNotFoundError | ConflictError | InvalidStateError>
  readonly reload: (input: ReloadInput) => Effect.Effect<Snapshot, NotFoundError | ConflictError | InvalidStateError>
  readonly rollback: (
    input: RollbackInput,
  ) => Effect.Effect<Snapshot, NotFoundError | ConflictError | InvalidStateError>
}

export type ProposalInput = SessionHarness.ProposalInput & { readonly sessionID: SessionSchema.ID }
export type ProposalStatusInput = SessionHarness.ProposalStatusInput & ProposalReference
export type ReviewerRequestInput = SessionHarness.ReviewerRequestInput & { readonly sessionID: SessionSchema.ID }
export type ReviewerRunInput = {
  readonly sessionID: SessionSchema.ID
  readonly reviewerSessionID: string
  readonly outcome: SessionHarness.ReviewerRunOutcome
  readonly detail?: string
}
export type ReloadInput = SessionHarness.ReloadInput & { readonly sessionID: SessionSchema.ID }
export type ProposalReference = {
  readonly sessionID: SessionSchema.ID
  readonly proposalID: SessionHarness.ProposalID
}
export type RollbackInput = SessionHarness.RollbackInput & { readonly sessionID: SessionSchema.ID }

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionHarness") {}

/**
 * Builds session tools from the active snapshot. Source is a CodeMode program with `input` and
 * `context` variables; the prefix and confined runtime keep it from shadowing built-ins or reaching
 * host filesystem, network, process, or module APIs. Permission is checked at execution time because
 * task-owned child authority is only resolved for the current Session.
 */
export function tools(
  snapshot: SessionHarness.HarnessSnapshot | undefined,
  permission: PermissionV2.Interface,
): Readonly<Record<string, Tool.AnyTool>> {
  if (!snapshot) return {}
  return Object.fromEntries(
    snapshot.tools.flatMap((descriptor) => {
      if (
        !descriptor.enabled ||
        !descriptor.readOnly ||
        !descriptor.name.startsWith("harness_") ||
        descriptor.name === REVIEW_REQUEST_TOOL_NAME
      )
        return []
      const source = sourceFor(snapshot, descriptor)
      if (!source) return []
      const tool = Tool.make({
        description: descriptor.description,
        input: Schema.Json,
        output: Schema.Json,
        execute: (input, context) =>
          permission
            .assert({
              action: descriptor.name,
              resources: [descriptor.name],
              sessionID: context.sessionID,
              agent: context.agent,
              source: {
                type: "tool",
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              },
            })
            .pipe(
              Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${descriptor.name}` })),
              Effect.andThen(
                executeHarnessProgram(
                  harnessProgram(source, input, {
                    sessionID: context.sessionID,
                    agent: context.agent,
                    assistantMessageID: context.assistantMessageID,
                    toolCallID: context.toolCallID,
                  }),
                ),
              ),
              Effect.flatMap((result) =>
                result.ok
                  ? Effect.succeed(result.value)
                  : Effect.fail(new ToolFailure({ message: `${result.error.kind}: ${result.error.message}` })),
              ),
            ),
      })
      return [[descriptor.name, Tool.withPermission(tool, descriptor.name)] as const]
    }),
  )
}

export function reviewRequestTool(harness: Interface, sessionID: SessionSchema.ID): Tool.AnyTool {
  const tool = Tool.make({
    description: "Send a focused request to the hidden automatic Harness reviewer.",
    input: SessionHarness.ReviewerRequestInput,
    output: Schema.Struct({ queued: Schema.Boolean }),
    execute: (input, context) =>
      harness
        .request({
          sessionID,
          id: input.id ?? `rr_${context.toolCallID}`,
          request: input.request,
        })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
        .pipe(Effect.as({ queued: true })),
  })
  return Tool.withPermission(tool, REVIEW_REQUEST_TOOL_NAME)
}

/**
 * Assembles the program a harness tool actually runs. Validation reuses this so a source that
 * passes the parse check at apply time is guaranteed to parse when the model calls it.
 */
function harnessProgram(source: string, input: unknown, context: Record<string, string>) {
  return [
    `const input = ${JSON.stringify(input) ?? "null"}`,
    `const context = ${JSON.stringify(context)}`,
    source,
  ].join(";\n")
}

/**
 * Rejects a source the interpreter cannot parse. CodeMode is a confined dialect with no module
 * system: it wraps the source in a function body and parses it as a script, so `import`/`export`,
 * `require`, and top-level declarations that need module scope are all unparseable. Without this
 * check the reviewer can auto-apply a tool that fails on every call it is ever given.
 */
function validateToolSource(source: string) {
  return executeHarnessProgram(
    harnessProgram(source, null, { sessionID: "", agent: "", assistantMessageID: "", toolCallID: "" }),
  ).pipe(
    Effect.map((result) =>
      !result.ok && result.error.kind === "ParseError" ? (result.error.message as string | undefined) : undefined,
    ),
  )
}

/**
 * Runs one harness program in the confined CodeMode interpreter. The interpreter has no module,
 * filesystem, network, or process access and is given no host tools.
 *
 * Execution is in-process. `timeoutMs` bounds interpreted control flow, because the evaluator is an
 * Effect generator that yields between steps, so runaway loops and recursion are interrupted. It
 * does NOT bound a single host builtin call: a catastrophic regex, a huge `repeat`, or stringifying
 * an enormous value occupies one synchronous frame, and neither timer can fire until it returns.
 * Both timeouts share that starved event loop, so the outer one is a backstop for late scheduling,
 * not independent isolation. Bounding host builtins needs an operation budget in the interpreter.
 */
function executeHarnessProgram(code: string) {
  return CodeMode.execute<{}>({
    code,
    tools: {},
    limits: {
      timeoutMs: HARNESS_TOOL_TIMEOUT_MS,
      maxToolCalls: 0,
      maxOutputBytes: HARNESS_TOOL_OUTPUT_BYTES,
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(HARNESS_TOOL_TIMEOUT_MS * 2),
      orElse: () => Effect.succeed(failure("TimeoutExceeded", `Harness tool exceeded ${HARNESS_TOOL_TIMEOUT_MS}ms`)),
    }),
    // Interruption means the turn is being torn down, so let it unwind instead of reporting a tool
    // result. Everything else is reported without Cause.pretty, which would put absolute host paths
    // and stack frames into model-visible context.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed(failure("ExecutionFailure", "Harness tool failed during execution")),
    ),
  )
}

function failure(kind: CodeMode.DiagnosticKind, message: string): CodeMode.Failure {
  return { ok: false, error: { kind, message }, toolCalls: [] }
}

type DatabaseRow = typeof SessionHarnessTable.$inferSelect
type Row = Omit<DatabaseRow, "snapshot" | "snapshots" | "proposals" | "reviewer_requests" | "reviewer_runs"> & {
  readonly snapshot: SessionHarness.HarnessSnapshot
  readonly snapshots: SessionHarness.HarnessSnapshot[]
  readonly proposals: SessionHarness.HarnessProposal[]
  readonly reviewer_requests: SessionHarness.ReviewerRequest[]
  readonly reviewer_runs: SessionHarness.ReviewerRun[]
}
type StoredState = {
  readonly version: number
  readonly snapshot: SessionHarness.HarnessSnapshot
  readonly snapshots: SessionHarness.HarnessSnapshot[]
  readonly proposals: SessionHarness.HarnessProposal[]
  readonly reviewerRequests?: SessionHarness.ReviewerRequest[]
  readonly reviewerRuns?: SessionHarness.ReviewerRun[]
}

class ProjectionConflict extends Error {
  constructor(
    readonly sessionID: SessionSchema.ID,
    message: string,
    readonly proposalID?: SessionHarness.ProposalID,
  ) {
    super(message)
  }
}

const DEFAULT_VERSION = 1
const encodeSnapshot = Schema.encodeSync(SessionHarness.HarnessSnapshot)
const decodeSnapshot = Schema.decodeUnknownSync(SessionHarness.HarnessSnapshot)
const encodeProposal = Schema.encodeSync(SessionHarness.HarnessProposal)
const decodeProposal = Schema.decodeUnknownSync(SessionHarness.HarnessProposal)
const encodeReviewerRequest = Schema.encodeSync(SessionHarness.ReviewerRequest)
const decodeReviewerRequest = Schema.decodeUnknownSync(SessionHarness.ReviewerRequest)
const encodeReviewerRun = Schema.encodeSync(SessionHarness.ReviewerRun)
const decodeReviewerRun = Schema.decodeUnknownSync(SessionHarness.ReviewerRun)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const primary = isWithReplicas(database.db) ? database.db.$primary : database.db
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service

    const readRow = Effect.fn("SessionHarness.readRow")(function* (sessionID: SessionSchema.ID) {
      const row = yield* primary
        .select()
        .from(SessionHarnessTable)
        .where(eq(SessionHarnessTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row
        ? {
            ...row,
            snapshot: decodeSnapshot(row.snapshot),
            snapshots: row.snapshots.map((snapshot) => decodeSnapshot(snapshot)),
            proposals: row.proposals.map((proposal) => decodeProposal(proposal)),
            reviewer_requests: row.reviewer_requests.map((request) => decodeReviewerRequest(request)),
            reviewer_runs: row.reviewer_runs.map((run) => decodeReviewerRun(run)),
          }
        : undefined
    })

    const requireSession = Effect.fn("SessionHarness.requireSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    const ensureRow = Effect.fn("SessionHarness.ensureRow")(function* (sessionID: SessionSchema.ID) {
      const existing = yield* readRow(sessionID)
      if (existing) return existing
      const now = yield* DateTime.now
      const snapshot = defaultSnapshot(now)
      yield* primary
        .insert(SessionHarnessTable)
        .values({
          session_id: sessionID,
          revision: 0,
          version: DEFAULT_VERSION,
          snapshot: encodeSnapshot(snapshot),
          snapshots: [encodeSnapshot(snapshot)],
          proposals: [],
          reviewer_requests: [],
          reviewer_runs: [],
          time_created: DateTime.toEpochMillis(now),
          time_updated: DateTime.toEpochMillis(now),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const row = yield* readRow(sessionID)
      if (!row) return yield* Effect.die("Session harness projection was not created")
      return row
    })

    const requireState = Effect.fn("SessionHarness.requireState")(function* (sessionID: SessionSchema.ID) {
      yield* requireSession(sessionID)
      return yield* ensureRow(sessionID)
    })

    const commit = (input: {
      readonly sessionID: SessionSchema.ID
      readonly expectedRevision?: number
      readonly updatedAt: number
      readonly update: (row: Row) => StoredState
    }) =>
      Effect.gen(function* () {
        const row = yield* readRow(input.sessionID)
        if (!row || (input.expectedRevision !== undefined && row.revision !== input.expectedRevision))
          return yield* Effect.die(
            new ProjectionConflict(input.sessionID, "Session harness changed while applying the operation"),
          )
        const next = input.update(row)
        if (!Number.isSafeInteger(row.revision + 1))
          return yield* Effect.die(new ProjectionConflict(input.sessionID, "Session harness revision overflowed"))
        const updated = yield* primary
          .update(SessionHarnessTable)
          .set({
            revision: row.revision + 1,
            version: next.version,
            snapshot: encodeSnapshot(next.snapshot),
            snapshots: next.snapshots.map((snapshot) => encodeSnapshot(snapshot)),
            proposals: next.proposals.map((proposal) => encodeProposal(proposal)),
            reviewer_requests: (next.reviewerRequests ?? row.reviewer_requests).map((request) =>
              encodeReviewerRequest(request),
            ),
            reviewer_runs: (next.reviewerRuns ?? row.reviewer_runs).map((run) => encodeReviewerRun(run)),
            time_updated: input.updatedAt,
          })
          .where(
            input.expectedRevision === undefined
              ? eq(SessionHarnessTable.session_id, input.sessionID)
              : and(
                  eq(SessionHarnessTable.session_id, input.sessionID),
                  eq(SessionHarnessTable.revision, input.expectedRevision),
                ),
          )
          .returning({ sessionID: SessionHarnessTable.session_id })
          .get()
          .pipe(Effect.orDie)
        if (!updated)
          return yield* Effect.die(
            new ProjectionConflict(input.sessionID, "Session harness changed while applying the operation"),
          )
      })

    const mapPublishDefect =
      (sessionID: SessionSchema.ID, proposalID?: SessionHarness.ProposalID) => (defect: unknown) => {
        if (defect instanceof ProjectionConflict)
          return Effect.fail(
            new ConflictError({
              sessionID,
              ...(proposalID ? { proposalID } : {}),
              message: defect.message,
            }),
          )
        return Effect.die(defect)
      }

    const result = Service.of({
      get: Effect.fn("SessionHarness.get")(function* (sessionID) {
        const row = yield* requireState(sessionID)
        return state(row)
      }),

      peek: Effect.fn("SessionHarness.peek")(function* (sessionID) {
        yield* requireSession(sessionID)
        const row = yield* readRow(sessionID)
        return row ? state(row) : { snapshot: null, proposals: [], reviewerRequests: [], reviewerRuns: [] }
      }),

      request: Effect.fn("SessionHarness.request")(function* (input) {
        yield* requireSession(input.sessionID)
        const row = yield* ensureRow(input.sessionID)
        const id = input.id ?? `rr_${Date.now()}_${input.sessionID.slice(-16)}`
        const existing = row.reviewer_requests.find((request) => request.id === id)
        if (existing) return existing
        const now = yield* DateTime.now
        const request: SessionHarness.ReviewerRequest = {
          id,
          request: input.request,
          timestamps: { created: now, updated: now },
        }
        yield* commit({
          sessionID: input.sessionID,
          expectedRevision: row.revision,
          updatedAt: DateTime.toEpochMillis(now),
          update: (current) => ({
            version: current.version,
            snapshot: current.snapshot,
            snapshots: current.snapshots,
            proposals: current.proposals,
            // Ring buffer: the oldest request is dropped rather than failing the agent's tool call,
            // which would otherwise brick harness_review_request for the rest of the session.
            reviewerRequests: [...current.reviewer_requests, request].slice(-SessionHarness.MAX_REVIEWER_REQUESTS),
          }),
        }).pipe(Effect.catchDefect(mapPublishDefect(input.sessionID)))
        return request
      }),

      /**
       * Records why one automatic review ended. This is observability for a background loop nobody
       * watches, so it never fails the caller: a lost run entry must not abort or retry the review.
       */
      recordRun: Effect.fn("SessionHarness.recordRun")(function* (input) {
        const row = yield* ensureRow(input.sessionID)
        const now = yield* DateTime.now
        const run: SessionHarness.ReviewerRun = {
          reviewerSessionID: input.reviewerSessionID,
          outcome: input.outcome,
          ...(input.detail ? { detail: input.detail.slice(0, SessionHarness.MAX_SUMMARY_LENGTH) } : {}),
          timestamp: now,
        }
        yield* commit({
          sessionID: input.sessionID,
          expectedRevision: row.revision,
          updatedAt: DateTime.toEpochMillis(now),
          update: (current) => ({
            version: current.version,
            snapshot: current.snapshot,
            snapshots: current.snapshots,
            proposals: current.proposals,
            reviewerRuns: [...current.reviewer_runs, run].slice(-SessionHarness.MAX_REVIEWER_RUNS),
          }),
        }).pipe(Effect.ignore)
      }),

      propose: Effect.fn("SessionHarness.propose")(function* (input) {
        const session = yield* requireSession(input.sessionID)
        const row = yield* ensureRow(input.sessionID)
        const existing = input.id ? row.proposals.find((proposal) => proposal.id === input.id) : undefined
        if (existing) {
          if (sameProposalInput(existing, input)) return existing
          return yield* new ConflictError({
            sessionID: input.sessionID,
            proposalID: existing.id,
            message: `Proposal ID is already used by a different harness proposal: ${existing.id}`,
          })
        }
        if (input.baseVersion !== row.version)
          return yield* versionConflict(input.sessionID, input.baseVersion, row.version)
        const changes = input.changes ?? []
        if (input.tools?.some((tool) => tool.name === REVIEW_REQUEST_TOOL_NAME))
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            message: `Harness tool name is reserved: ${REVIEW_REQUEST_TOOL_NAME}`,
          })
        if (harnessBytes(changes, input.tools ?? []) > SessionHarness.MAX_SNAPSHOT_BYTES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            message: `Harness proposal exceeds the ${SessionHarness.MAX_SNAPSHOT_BYTES}-byte content limit`,
          })
        if (stateBytes(row) + harnessBytes(changes, input.tools ?? []) > SessionHarness.MAX_STATE_BYTES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            message: `Session harness state exceeds the ${SessionHarness.MAX_STATE_BYTES}-byte content limit`,
          })

        const now = yield* DateTime.now
        const proposal: SessionHarness.HarnessProposal = {
          id: input.id ?? SessionHarness.ProposalID.create(),
          baseVersion: input.baseVersion,
          summary: input.summary,
          changes: changes.map(copyChange),
          ...(input.tools ? { tools: input.tools.map(copyTool) } : {}),
          ...(input.guidance ? { guidance: input.guidance.map(copyGuidance) } : {}),
          status: "pending",
          validation: emptyValidation(),
          timestamps: { created: now, updated: now },
        }
        yield* events
          .publish(
            SessionEvent.Harness.ProposalCreated,
            { sessionID: input.sessionID, timestamp: now, proposal },
            {
              location: session.location,
              commit: () =>
                commit({
                  sessionID: input.sessionID,
                  updatedAt: DateTime.toEpochMillis(now),
                  update: (current) => {
                    if (current.version !== input.baseVersion)
                      throw new ProjectionConflict(
                        input.sessionID,
                        `Expected harness snapshot version ${input.baseVersion}, found ${current.version}`,
                        proposal.id,
                      )
                    if (current.proposals.some((item) => item.id === proposal.id))
                      throw new ProjectionConflict(
                        input.sessionID,
                        "Harness proposal ID was concurrently reused",
                        proposal.id,
                      )
                    return {
                      version: current.version,
                      snapshot: current.snapshot,
                      snapshots: current.snapshots,
                      proposals: appendProposal(current.proposals, proposal),
                    }
                  },
                }),
            },
          )
          .pipe(Effect.catchDefect(mapPublishDefect(input.sessionID, proposal.id)))
        return proposal
      }),

      status: Effect.fn("SessionHarness.status")(function* (input) {
        const session = yield* requireSession(input.sessionID)
        const row = yield* ensureRow(input.sessionID)
        const proposal = row.proposals.find((item) => item.id === input.proposalID)
        if (!proposal) return yield* new ProposalNotFoundError(input)
        if (input.status === "approved" && proposal.baseVersion !== row.version)
          return yield* versionConflict(input.sessionID, proposal.baseVersion, row.version, input.proposalID)
        const validation = input.validation ?? proposal.validation
        if (proposal.status === input.status && sameValidation(proposal.validation, validation)) return proposal
        if (proposal.status === "applied" && input.status !== "applied")
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: "An applied harness proposal cannot change status",
          })
        if (input.status === "applied" && proposal.status !== "applied")
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: "Harness proposals become applied only when they are applied as a snapshot",
          })

        const now = yield* DateTime.now
        const updated: SessionHarness.HarnessProposal = {
          ...proposal,
          status: input.status,
          validation: copyValidation(validation),
          timestamps: { ...proposal.timestamps, updated: now },
        }
        yield* events
          .publish(
            SessionEvent.Harness.ProposalStatus,
            {
              sessionID: input.sessionID,
              timestamp: now,
              proposalID: input.proposalID,
              status: input.status,
              ...(input.validation ? { validation: copyValidation(input.validation) } : {}),
            },
            {
              location: session.location,
              commit: () =>
                commit({
                  sessionID: input.sessionID,
                  expectedRevision: row.revision,
                  updatedAt: DateTime.toEpochMillis(now),
                  update: (current) => {
                    const currentProposal = current.proposals.find((item) => item.id === input.proposalID)
                    if (!currentProposal || currentProposal.status !== proposal.status)
                      throw new ProjectionConflict(
                        input.sessionID,
                        "Harness proposal changed while updating status",
                        input.proposalID,
                      )
                    return {
                      version: current.version,
                      snapshot: current.snapshot,
                      snapshots: current.snapshots,
                      proposals: current.proposals.map((item) => (item.id === updated.id ? updated : item)),
                    }
                  },
                }),
            },
          )
          .pipe(Effect.catchDefect(mapPublishDefect(input.sessionID, input.proposalID)))
        return updated
      }),

      apply: Effect.fn("SessionHarness.apply")(function* (input) {
        const session = yield* requireSession(input.sessionID)
        const row = yield* ensureRow(input.sessionID)
        const proposal = row.proposals.find((item) => item.id === input.proposalID)
        if (!proposal) return yield* new ProposalNotFoundError(input)
        if (proposal.status === "applied") {
          const applied = proposal.appliedVersion
            ? row.snapshots.find((snapshot) => snapshot.version === proposal.appliedVersion)
            : undefined
          if (applied) return applied
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: "The snapshot produced by this harness proposal is no longer retained",
          })
        }
        if (proposal.status !== "approved")
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: `Only approved harness proposals can be applied (current status: ${proposal.status})`,
          })
        if (proposal.baseVersion !== row.version)
          return yield* versionConflict(input.sessionID, proposal.baseVersion, row.version, input.proposalID)

        const now = yield* DateTime.now
        const mergedChanges = mergeChanges(row.snapshot.changes, proposal.changes)
        const mergedTools = proposal.tools?.map(copyTool) ?? row.snapshot.tools.map(copyTool)
        if (mergedTools.some((tool) => tool.name === REVIEW_REQUEST_TOOL_NAME))
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: `Harness tool name is reserved: ${REVIEW_REQUEST_TOOL_NAME}`,
          })
        if (mergedChanges.length > SessionHarness.MAX_CHANGES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: `Applying this harness proposal would exceed the ${SessionHarness.MAX_CHANGES}-change snapshot limit`,
          })
        if (harnessBytes(mergedChanges, mergedTools) > SessionHarness.MAX_SNAPSHOT_BYTES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: `Applying this harness proposal exceeds the ${SessionHarness.MAX_SNAPSHOT_BYTES}-byte content limit`,
          })
        const missingSource = missingToolSource(mergedTools, mergedChanges)
        if (missingSource)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: `Enabled harness tool ${missingSource.name} has no complete source content`,
          })
        for (const descriptor of mergedTools) {
          if (!descriptor.enabled || !descriptor.readOnly) continue
          const source = sourceForChanges(mergedChanges, descriptor)
          const parseError = source === undefined ? undefined : yield* validateToolSource(source)
          if (parseError)
            return yield* new InvalidStateError({
              sessionID: input.sessionID,
              proposalID: input.proposalID,
              message: `Harness tool ${descriptor.name} has unparseable source: ${parseError}`,
            })
        }
        const snapshot = proposalSnapshot(row.snapshot, proposal, now, input.sessionID, mergedChanges, mergedTools)
        if (stateBytes(row) + harnessBytes(snapshot.changes, snapshot.tools) > SessionHarness.MAX_STATE_BYTES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            proposalID: input.proposalID,
            message: `Session harness state exceeds the ${SessionHarness.MAX_STATE_BYTES}-byte content limit`,
          })
        yield* events
          .publish(
            SessionEvent.Harness.SnapshotCreated,
            { sessionID: input.sessionID, timestamp: now, proposalID: input.proposalID, snapshot },
            {
              location: session.location,
              commit: () =>
                commit({
                  sessionID: input.sessionID,
                  expectedRevision: row.revision,
                  updatedAt: DateTime.toEpochMillis(now),
                  update: (current) => {
                    const currentProposal = current.proposals.find((item) => item.id === input.proposalID)
                    if (
                      !currentProposal ||
                      currentProposal.status !== "approved" ||
                      currentProposal.baseVersion !== current.version
                    )
                      throw new ProjectionConflict(
                        input.sessionID,
                        "Harness proposal changed before apply",
                        input.proposalID,
                      )
                    const nextSnapshot = proposalSnapshot(current.snapshot, currentProposal, now, input.sessionID)
                    const applied: SessionHarness.HarnessProposal = {
                      ...currentProposal,
                      status: "applied",
                      appliedVersion: nextSnapshot.version,
                      timestamps: { ...currentProposal.timestamps, updated: now },
                    }
                    return {
                      version: nextSnapshot.version,
                      snapshot: nextSnapshot,
                      snapshots: appendSnapshot(current.snapshots, current.version, "superseded", nextSnapshot),
                      proposals: current.proposals.map((item) => (item.id === applied.id ? applied : item)),
                    }
                  },
                }),
            },
          )
          .pipe(Effect.catchDefect(mapPublishDefect(input.sessionID, input.proposalID)))
        // Keep the applied lifecycle transition visible in the Session event stream. The snapshot
        // event owns the state transaction above; this notification is intentionally after it.
        yield* events.publish(
          SessionEvent.Harness.ProposalStatus,
          {
            sessionID: input.sessionID,
            timestamp: now,
            proposalID: input.proposalID,
            status: "applied",
            validation: copyValidation(proposal.validation),
          },
          { location: session.location },
        )
        return snapshot
      }),

      reload: Effect.fn("SessionHarness.reload")(function* (input) {
        const session = yield* requireSession(input.sessionID)
        const row = yield* ensureRow(input.sessionID)
        if (input.baseVersion !== row.version)
          return yield* versionConflict(input.sessionID, input.baseVersion, row.version)
        const now = yield* DateTime.now
        const snapshot = reloadSnapshot(row.snapshot, now, input.sessionID)
        if (stateBytes(row) + harnessBytes(snapshot.changes, snapshot.tools) > SessionHarness.MAX_STATE_BYTES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            message: `Session harness state exceeds the ${SessionHarness.MAX_STATE_BYTES}-byte content limit`,
          })
        yield* events
          .publish(
            SessionEvent.Harness.SnapshotCreated,
            { sessionID: input.sessionID, timestamp: now, snapshot },
            {
              location: session.location,
              commit: () =>
                commit({
                  sessionID: input.sessionID,
                  expectedRevision: row.revision,
                  updatedAt: DateTime.toEpochMillis(now),
                  update: (current) => {
                    if (current.version !== input.baseVersion)
                      throw new ProjectionConflict(input.sessionID, "Harness reload is based on a stale snapshot")
                    const nextSnapshot = reloadSnapshot(current.snapshot, now, input.sessionID)
                    return {
                      version: nextSnapshot.version,
                      snapshot: nextSnapshot,
                      snapshots: appendSnapshot(current.snapshots, current.version, "superseded", nextSnapshot),
                      proposals: current.proposals,
                    }
                  },
                }),
            },
          )
          .pipe(Effect.catchDefect(mapPublishDefect(input.sessionID)))
        yield* events.publish(
          SessionEvent.Harness.Reloaded,
          { sessionID: input.sessionID, timestamp: now, version: snapshot.version },
          { location: session.location },
        )
        return snapshot
      }),

      rollback: Effect.fn("SessionHarness.rollback")(function* (input) {
        const session = yield* requireSession(input.sessionID)
        const row = yield* ensureRow(input.sessionID)
        if (input.baseVersion !== row.version)
          return yield* versionConflict(input.sessionID, input.baseVersion, row.version)
        const target = row.snapshots.find((item) => item.version === input.version)
        if (!target || input.version >= row.version)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            message: `Harness snapshot version ${input.version} is not a prior version`,
          })
        const now = yield* DateTime.now
        const snapshot = rollbackSnapshot(target, row.version, now, input.sessionID)
        if (stateBytes(row) + harnessBytes(snapshot.changes, snapshot.tools) > SessionHarness.MAX_STATE_BYTES)
          return yield* new InvalidStateError({
            sessionID: input.sessionID,
            message: `Session harness state exceeds the ${SessionHarness.MAX_STATE_BYTES}-byte content limit`,
          })
        yield* events
          .publish(
            SessionEvent.Harness.SnapshotCreated,
            { sessionID: input.sessionID, timestamp: now, snapshot },
            {
              location: session.location,
              commit: () =>
                commit({
                  sessionID: input.sessionID,
                  expectedRevision: row.revision,
                  updatedAt: DateTime.toEpochMillis(now),
                  update: (current) => {
                    const currentTarget = current.snapshots.find((item) => item.version === input.version)
                    if (current.version !== input.baseVersion || !currentTarget || input.version >= current.version)
                      throw new ProjectionConflict(input.sessionID, "Harness rollback target is no longer available")
                    const nextSnapshot = rollbackSnapshot(currentTarget, current.version, now, input.sessionID)
                    return {
                      version: nextSnapshot.version,
                      snapshot: nextSnapshot,
                      snapshots: appendSnapshot(current.snapshots, current.version, "rolledBack", nextSnapshot),
                      proposals: current.proposals,
                    }
                  },
                }),
            },
          )
          .pipe(Effect.catchDefect(mapPublishDefect(input.sessionID)))
        return snapshot
      }),
    })

    return result
  }),
)

function state(row: Row): State {
  return {
    snapshot: row.snapshot,
    proposals: row.proposals,
    reviewerRequests: row.reviewer_requests,
    reviewerRuns: row.reviewer_runs,
  }
}

function defaultSnapshot(now: DateTime.Utc): SessionHarness.HarnessSnapshot {
  return {
    version: SessionHarness.Version.make(DEFAULT_VERSION),
    status: "active",
    source: "default",
    changes: [],
    tools: [],
    validation: emptyValidation(),
    timestamps: { created: now, updated: now },
  }
}

function emptyValidation(): SessionHarness.Validation {
  return { status: "pending", errors: [], warnings: [] }
}

function copyValidation(validation: SessionHarness.Validation): SessionHarness.Validation {
  return {
    status: validation.status,
    errors: [...validation.errors],
    warnings: [...validation.warnings],
  }
}

function sameValidation(left: SessionHarness.Validation, right: SessionHarness.Validation) {
  return (
    left.status === right.status &&
    left.errors.length === right.errors.length &&
    left.errors.every((error, index) => error === right.errors[index]) &&
    left.warnings.length === right.warnings.length &&
    left.warnings.every((warning, index) => warning === right.warnings[index])
  )
}

function sameProposalInput(proposal: SessionHarness.HarnessProposal, input: SessionHarness.ProposalInput) {
  return (
    proposal.baseVersion === input.baseVersion &&
    proposal.summary === input.summary &&
    proposal.changes.length === (input.changes ?? []).length &&
    proposal.changes.every((change, index) => sameChange(change, input.changes?.[index])) &&
    sameOptionalList(proposal.tools, input.tools, sameTool) &&
    sameOptionalList(proposal.guidance, input.guidance, sameGuidance)
  )
}

/** Absent and empty are different: absent means "leave the snapshot's list alone". */
function sameOptionalList<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  same: (left: T, right: T | undefined) => boolean,
) {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((item, index) => same(item, right[index]))
}

function sameChange(left: SessionHarness.HarnessChange, right: SessionHarness.HarnessChange | undefined) {
  if (!right || left.path !== right.path || left.operation !== right.operation) return false
  return left.summary === right.summary && left.patch === right.patch && left.content === right.content
}

function copyChange(change: SessionHarness.HarnessChange): SessionHarness.HarnessChange {
  return { ...change }
}

function copyTool(tool: SessionHarness.HarnessTool): SessionHarness.HarnessTool {
  return { ...tool }
}

function copyGuidance(guidance: SessionHarness.HarnessGuidance): SessionHarness.HarnessGuidance {
  return { ...guidance }
}

function sameGuidance(left: SessionHarness.HarnessGuidance, right: SessionHarness.HarnessGuidance | undefined) {
  return right !== undefined && left.directive === right.directive && left.appliesTo === right.appliesTo
}

function sameTool(left: SessionHarness.HarnessTool, right: SessionHarness.HarnessTool | undefined) {
  return (
    right !== undefined &&
    left.name === right.name &&
    left.description === right.description &&
    left.source === right.source &&
    left.readOnly === right.readOnly &&
    left.enabled === right.enabled
  )
}

function sourceFor(snapshot: SessionHarness.HarnessSnapshot, descriptor: SessionHarness.HarnessTool) {
  return sourceForChanges(snapshot.changes, descriptor)
}

function sourceForChanges(changes: readonly SessionHarness.HarnessChange[], descriptor: SessionHarness.HarnessTool) {
  // Ordered, not positional: the descriptor's declared source wins over the name-derived fallbacks.
  // Matching on a set and taking the last change let an unrelated fallback path shadow the source a
  // human actually approved.
  const paths = [descriptor.source, `src/tools/${descriptor.name}.ts`, `tools/${descriptor.name}.ts`].filter(
    (path): path is NonNullable<typeof path> => path !== undefined,
  )
  for (const path of paths) {
    const content = changes.findLast(
      (change) => change.path === path && change.operation !== "delete" && change.content !== undefined,
    )?.content
    if (content !== undefined) return content
  }
  return undefined
}

function missingToolSource(
  tools: readonly SessionHarness.HarnessTool[],
  changes: readonly SessionHarness.HarnessChange[],
) {
  return tools.find(
    (descriptor) => descriptor.enabled && descriptor.readOnly && sourceForChanges(changes, descriptor) === undefined,
  )
}

function versionConflict(
  sessionID: SessionSchema.ID,
  expected: number,
  actual: number,
  proposalID?: SessionHarness.ProposalID,
): Effect.Effect<never, ConflictError> {
  return Effect.fail(
    new ConflictError({
      sessionID,
      ...(proposalID ? { proposalID } : {}),
      message: `Expected harness snapshot version ${expected}, found ${actual}`,
    }),
  )
}

function nextVersion(version: number, sessionID: SessionSchema.ID): SessionHarness.Version {
  if (!Number.isSafeInteger(version + 1) || version >= Number.MAX_SAFE_INTEGER)
    throw new ProjectionConflict(sessionID, "Harness snapshot version overflowed")
  return (version + 1) as SessionHarness.Version
}

function archive(
  snapshots: readonly SessionHarness.HarnessSnapshot[],
  version: number,
  status: SessionHarness.SnapshotStatus,
): SessionHarness.HarnessSnapshot[] {
  return snapshots.map((snapshot) => (snapshot.version === version ? { ...snapshot, status } : { ...snapshot }))
}

function appendSnapshot(
  snapshots: readonly SessionHarness.HarnessSnapshot[],
  version: number,
  status: SessionHarness.SnapshotStatus,
  next: SessionHarness.HarnessSnapshot,
): SessionHarness.HarnessSnapshot[] {
  return [...archive(snapshots, version, status), next].slice(-SessionHarness.MAX_SNAPSHOTS)
}

function proposalSnapshot(
  current: SessionHarness.HarnessSnapshot,
  proposal: SessionHarness.HarnessProposal,
  now: DateTime.Utc,
  sessionID: SessionSchema.ID,
  changes = mergeChanges(current.changes, proposal.changes),
  tools = proposal.tools?.map(copyTool) ?? current.tools.map(copyTool),
): SessionHarness.HarnessSnapshot {
  return {
    version: nextVersion(current.version, sessionID),
    parent: current.version,
    status: "active",
    source: "proposal",
    changes,
    tools,
    // Replacement, like tools: a proposal that sends guidance sends the whole list it wants.
    guidance: (proposal.guidance ?? current.guidance ?? []).map(copyGuidance),
    validation: copyValidation(proposal.validation),
    timestamps: { created: now, updated: now },
  }
}

/**
 * Appends a proposal, evicting settled ones once the cap is reached. Failing instead would be
 * permanent: the automatic reviewer proposes continuously, so a hard cap bricks it within hours.
 * Pending proposals are kept as long as possible because they are still waiting on a human.
 */
function appendProposal(
  current: readonly SessionHarness.HarnessProposal[],
  next: SessionHarness.HarnessProposal,
): SessionHarness.HarnessProposal[] {
  const kept = [...current, next]
  if (kept.length <= SessionHarness.MAX_PROPOSALS) return kept
  const settled = kept
    .filter((proposal) => proposal.status === "applied" || proposal.status === "rejected")
    .slice(0, kept.length - SessionHarness.MAX_PROPOSALS)
  const evicted = new Set(settled.map((proposal) => proposal.id))
  const pruned = kept.filter((proposal) => !evicted.has(proposal.id))
  return pruned.slice(-SessionHarness.MAX_PROPOSALS)
}

function mergeChanges(
  current: readonly SessionHarness.HarnessChange[],
  proposed: readonly SessionHarness.HarnessChange[],
): SessionHarness.HarnessChange[] {
  const changes = new Map(current.map((change) => [change.path, copyChange(change)]))
  proposed.forEach((change) => changes.set(change.path, copyChange(change)))
  return [...changes.values()]
}

function harnessBytes(
  changes: readonly SessionHarness.HarnessChange[],
  tools: readonly SessionHarness.HarnessTool[],
): number {
  const text = new TextEncoder()
  return (
    changes.reduce(
      (total, change) =>
        total +
        text.encode(change.path).byteLength +
        text.encode(change.summary ?? "").byteLength +
        text.encode(change.patch ?? "").byteLength +
        text.encode(change.content ?? "").byteLength,
      0,
    ) +
    tools.reduce(
      (total, tool) =>
        total +
        text.encode(tool.name).byteLength +
        text.encode(tool.description).byteLength +
        text.encode(tool.source ?? "").byteLength,
      0,
    )
  )
}

function stateBytes(row: Row) {
  return (
    harnessBytes(row.snapshot.changes, row.snapshot.tools) +
    row.snapshots.reduce((total, snapshot) => total + harnessBytes(snapshot.changes, snapshot.tools), 0) +
    row.proposals.reduce((total, proposal) => total + harnessBytes(proposal.changes, proposal.tools ?? []), 0) +
    row.reviewer_requests.reduce((total, request) => total + request.request.length + request.id.length, 0)
  )
}

function reloadSnapshot(
  current: SessionHarness.HarnessSnapshot,
  now: DateTime.Utc,
  sessionID: SessionSchema.ID,
): SessionHarness.HarnessSnapshot {
  return {
    version: nextVersion(current.version, sessionID),
    parent: current.version,
    status: "active",
    source: "reload",
    changes: current.changes.map(copyChange),
    tools: current.tools.map(copyTool),
    guidance: (current.guidance ?? []).map(copyGuidance),
    validation: copyValidation(current.validation),
    timestamps: { created: now, updated: now },
  }
}

function rollbackSnapshot(
  target: SessionHarness.HarnessSnapshot,
  currentVersion: number,
  now: DateTime.Utc,
  sessionID: SessionSchema.ID,
): SessionHarness.HarnessSnapshot {
  return {
    version: nextVersion(currentVersion, sessionID),
    parent: target.version,
    status: "active",
    source: "rollback",
    changes: target.changes.map(copyChange),
    tools: target.tools.map(copyTool),
    guidance: (target.guidance ?? []).map(copyGuidance),
    validation: copyValidation(target.validation),
    timestamps: { created: now, updated: now },
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node, SessionStore.node] })
