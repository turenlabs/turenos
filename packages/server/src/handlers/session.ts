import { SessionV2 } from "@turenlabs/core/session"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionTerminal } from "@turenlabs/core/session/terminal"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SwarmRoom } from "@turenlabs/core/team/room"
import { TeamBoard } from "@turenlabs/core/team/board"
import { SessionLegacyExecution } from "@turenlabs/core/session/legacy-execution"
import { SessionTranscriptAdoption } from "@turenlabs/core/session/transcript-adoption"
import { MessageDecodeError } from "@turenlabs/core/session/error"
import { DateTime, Effect, Schema, Stream } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor, SessionTaskCursor, SessionTaskResponseLimits } from "@turenlabs/protocol/groups/session"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@turenlabs/protocol/errors"
import { AbsolutePath } from "@turenlabs/core/schema"
import { AgentV2 } from "@turenlabs/core/agent"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { INACTIVE_AFTER_MS } from "@turenlabs/schema/session"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50
const DefaultSessionReplayLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const harness = yield* SessionHarness.Service
    const execution = yield* SessionExecution.Service
    const tasks = yield* SessionTaskV2.Service
    const teamBoard = yield* TeamBoard.Service
    const rooms = yield* SwarmRoom.Service

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : {
                  ...ctx.query,
                  ...(ctx.query.inactive === undefined ? {} : { inactivityThreshold: Date.now() - INACTIVE_AFTER_MS }),
                }
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            roots: query.roots,
            internal: query.internal,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          const anchorTime = (item: NonNullable<typeof first>) =>
            DateTime.toEpochMillis(query.inactive === undefined ? item.time.created : item.time.updated)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: anchorTime(first),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: anchorTime(last),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              metadata: ctx.payload.metadata,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.replay",
        Effect.fn(function* (ctx) {
          const page = yield* session
            .replay({
              query: ctx.query.query ?? "",
              limit: ctx.query.limit ?? DefaultSessionReplayLimit,
              cursor: ctx.query.cursor,
            })
            .pipe(
              Effect.catchTag(
                "SessionReplay.QueryError",
                (error) =>
                  new InvalidRequestError({
                    message: `${error.message} at column ${error.position + 1}`,
                    kind: "session_replay_query",
                    field: "query",
                  }),
              ),
            )
          return {
            data: page.entries,
            total: page.total,
            nextCursor: page.nextCursor,
            index: page.index,
            parsed: page.parsed,
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "session.interruptAll",
        Effect.fn(function* () {
          return { data: yield* session.interruptAll() }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.terminal.get",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.mapError(sessionNotFound))
          const terminal = yield* SessionTerminal.Service
          return { data: (yield* terminal.get(ctx.params.sessionID)) ?? null }
        }),
      )
      .handle(
        "session.terminal.create",
        Effect.fn(function* (ctx) {
          const terminal = yield* SessionTerminal.Service
          return { data: yield* terminal.create(ctx.params.sessionID).pipe(Effect.mapError(sessionTerminalNotFound)) }
        }),
      )
      .handle(
        "session.terminal.share",
        Effect.fn(function* (ctx) {
          const terminal = yield* SessionTerminal.Service
          return {
            data: yield* terminal
              .share({ sessionID: ctx.params.sessionID, shared: ctx.payload.shared })
              .pipe(Effect.mapError(sessionTerminalNotFound)),
          }
        }),
      )
      .handle(
        "session.terminal.remove",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.mapError(sessionNotFound))
          const terminal = yield* SessionTerminal.Service
          yield* terminal.remove(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.harness.state",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness.get(ctx.params.sessionID).pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.harness.proposal",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness
              .propose({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.harness.proposalStatus",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness
              .status({ sessionID: ctx.params.sessionID, proposalID: ctx.params.proposalID, ...ctx.payload })
              .pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.harness.proposalApply",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness
              .apply({ sessionID: ctx.params.sessionID, proposalID: ctx.params.proposalID })
              .pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.harness.proposalReject",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness
              .status({
                sessionID: ctx.params.sessionID,
                proposalID: ctx.params.proposalID,
                status: "rejected",
              })
              .pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.harness.reload",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness
              .reload({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.harness.rollback",
        Effect.fn(function* (ctx) {
          return {
            data: yield* harness
              .rollback({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(harnessError)),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
            Effect.catchTag(
              "SessionTranscriptAdoption.AdoptionError",
              (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
            ),
            Effect.catchTag(
              "SessionLegacyExecution.QuiescenceUnavailableError",
              (error) =>
                new InvalidRequestError({
                  kind: "session_transcript_adoption",
                  message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
            Effect.catchTag(
              "SessionTranscriptAdoption.AdoptionError",
              (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
            ),
            Effect.catchTag(
              "SessionLegacyExecution.QuiescenceUnavailableError",
              (error) =>
                new InvalidRequestError({
                  kind: "session_transcript_adoption",
                  message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "SessionTranscriptAdoption.AdoptionError",
                  (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
                ),
                Effect.catchTag(
                  "SessionLegacyExecution.QuiescenceUnavailableError",
                  (error) =>
                    new InvalidRequestError({
                      kind: "session_transcript_adoption",
                      message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Session.AutomationOwnedError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: "This Session is owned by an active Automation",
                      resource: error.sessionID,
                    }),
                  ),
                ),
                Effect.catchTag("SessionRevert.GoalBoundaryError", (error) => Effect.fail(revertGoalConflict(error))),
              ),
          }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .shell({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                command: ctx.payload.command,
                timeout: ctx.payload.timeout,
              })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "SessionTranscriptAdoption.AdoptionError",
                  (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
                ),
                Effect.catchTag(
                  "SessionLegacyExecution.QuiescenceUnavailableError",
                  (error) =>
                    new InvalidRequestError({
                      kind: "session_transcript_adoption",
                      message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTags({
                  "SessionShell.BusyError": (error) =>
                    new ConflictError({ message: error.message, resource: error.messageID }),
                  "SessionShell.SessionBusyError": (error) =>
                    new ConflictError({ message: error.message, resource: error.sessionID }),
                  "SessionShell.ConflictError": (error) =>
                    new ConflictError({ message: error.message, resource: error.messageID }),
                  "SessionShell.InvalidCommandError": (error) =>
                    new InvalidRequestError({ kind: "session_shell", message: error.message }),
                  "SessionShell.InvalidTimeoutError": (error) =>
                    new InvalidRequestError({ kind: "session_shell", message: error.message }),
                }),
              ),
          }
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .command({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                command: ctx.payload.command,
                arguments: ctx.payload.arguments,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
                files: ctx.payload.files,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "SessionTranscriptAdoption.AdoptionError",
                  (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
                ),
                Effect.catchTag(
                  "SessionLegacyExecution.QuiescenceUnavailableError",
                  (error) =>
                    new InvalidRequestError({
                      kind: "session_transcript_adoption",
                      message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag(
                  "Session.PromptConflictError",
                  (error) =>
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable input: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                ),
                Effect.catchTag("SessionRevert.GoalBoundaryError", (error) => Effect.fail(revertGoalConflict(error))),
                Effect.catchTags({
                  "SessionCommand.NotFoundError": (error) =>
                    new InvalidRequestError({ kind: "session_command", message: error.message }),
                  "SessionCommand.AgentNotFoundError": (error) =>
                    new InvalidRequestError({ kind: "session_command", message: error.message }),
                  "SessionCommand.UnsupportedError": (error) =>
                    new InvalidRequestError({ kind: "session_command", message: error.message }),
                }),
              ),
          }
        }),
      )
      .handle(
        "session.resume",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.recover(ctx.params.sessionID).pipe(
              Effect.mapError((error) => {
                if (Schema.is(SessionV2.NotFoundError)(error))
                  return new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  })
                if (Schema.is(SessionTranscriptAdoption.AdoptionError)(error))
                  return new InvalidRequestError({
                    kind: "session_transcript_adoption",
                    message: error.message,
                  })
                if (Schema.is(SessionLegacyExecution.QuiescenceUnavailableError)(error))
                  return new InvalidRequestError({
                    kind: "session_transcript_adoption",
                    message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                  })
                if (Schema.is(MessageDecodeError)(error))
                  return new InvalidRequestError({
                    kind: "session_recovery",
                    message: `Session recovery could not decode message: ${error.messageID}`,
                  })
                return new ServiceUnavailableError({
                  service: "session.resume",
                  message: "Session recovery could not be scheduled",
                })
              }),
            ),
          }
        }),
      )
      .handle(
        "session.goalGet",
        Effect.fn(function* (ctx) {
          return {
            data:
              (yield* session.goal.get(ctx.params.sessionID).pipe(
                Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
              )) ?? null,
          }
        }),
      )
      .handle(
        "session.goalSet",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.goal
              .set({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                messageID: ctx.payload.messageID,
                objective: ctx.payload.objective,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
              })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "SessionTranscriptAdoption.AdoptionError",
                  (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
                ),
                Effect.catchTag(
                  "SessionLegacyExecution.QuiescenceUnavailableError",
                  (error) =>
                    new InvalidRequestError({
                      kind: "session_transcript_adoption",
                      message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.ConflictError", (error) => Effect.fail(goalConflict(error))),
                Effect.catchTag("SessionRevert.GoalBoundaryError", (error) => Effect.fail(revertGoalConflict(error))),
              ),
          }
        }),
      )
      .handle(
        "session.goalEdit",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.goal
              .edit({
                sessionID: ctx.params.sessionID,
                goalID: ctx.payload.goalID,
                expectedRevision: ctx.payload.expectedRevision,
                objective: ctx.payload.objective,
              })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "SessionTranscriptAdoption.AdoptionError",
                  (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
                ),
                Effect.catchTag(
                  "SessionLegacyExecution.QuiescenceUnavailableError",
                  (error) =>
                    new InvalidRequestError({
                      kind: "session_transcript_adoption",
                      message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.ConflictError", (error) => Effect.fail(goalConflict(error))),
                Effect.catchTag("SessionGoal.InvalidStateError", (error) => Effect.fail(goalInvalidState(error))),
              ),
          }
        }),
      )
      .handle(
        "session.goalStatus",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.goal
              .status({
                sessionID: ctx.params.sessionID,
                goalID: ctx.payload.goalID,
                expectedRevision: ctx.payload.expectedRevision,
                status: ctx.payload.status,
              })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "SessionTranscriptAdoption.AdoptionError",
                  (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
                ),
                Effect.catchTag(
                  "SessionLegacyExecution.QuiescenceUnavailableError",
                  (error) =>
                    new InvalidRequestError({
                      kind: "session_transcript_adoption",
                      message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
                Effect.catchTag("SessionGoal.ConflictError", (error) => Effect.fail(goalConflict(error))),
                Effect.catchTag("SessionGoal.InvalidStateError", (error) => Effect.fail(goalInvalidState(error))),
              ),
          }
        }),
      )
      .handle(
        "session.goalClear",
        Effect.fn(function* (ctx) {
          yield* session.goal
            .clear({
              sessionID: ctx.params.sessionID,
              goalID: ctx.payload.goalID,
              expectedRevision: ctx.payload.expectedRevision,
            })
            .pipe(
              Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
              Effect.catchTag(
                "SessionTranscriptAdoption.AdoptionError",
                (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
              ),
              Effect.catchTag(
                "SessionLegacyExecution.QuiescenceUnavailableError",
                (error) =>
                  new InvalidRequestError({
                    kind: "session_transcript_adoption",
                    message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
              Effect.catchTag("SessionGoal.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
              Effect.catchTag("SessionGoal.ConflictError", (error) => Effect.fail(goalConflict(error))),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.taskList",
        Effect.fn(function* (ctx) {
          const owner = yield* tasks.owner(ctx.params.sessionID)
          const rootSessionID = owner?.rootSessionID ?? ctx.params.sessionID
          const cursor =
            ctx.query.cursor === undefined
              ? undefined
              : yield* SessionTaskCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
          if (cursor && cursor.rootSessionID !== rootSessionID)
            return yield* new InvalidCursorError({ message: "Invalid cursor" })
          const limit = ctx.query.limit ?? SessionTaskResponseLimits.pageDefault
          const page = yield* tasks.listPage({
            rootSessionID,
            after: cursor ? { timeCreated: cursor.timeCreated, id: cursor.id } : undefined,
            limit: limit + 1,
          })
          const data = page.slice(0, limit)
          const active = yield* tasks.listActive(rootSessionID)
          const last = data.at(-1)
          return {
            data: data.map(taskSummary),
            active: active.map(taskSummary),
            cursor: {
              next:
                page.length > limit && last
                  ? SessionTaskCursor.make({
                      rootSessionID,
                      timeCreated: DateTime.toEpochMillis(last.time.created),
                      id: last.id,
                    })
                  : undefined,
            },
          }
        }),
      )
      .handle(
        "session.taskGet",
        Effect.fn(function* (ctx) {
          const owner = yield* tasks.owner(ctx.params.sessionID)
          const task = yield* tasks.get(ctx.params.taskID)
          if (task && task.rootSessionID === (owner?.rootSessionID ?? ctx.params.sessionID))
            return { data: taskDetail(task) }
          return yield* new InvalidRequestError({
            kind: "session_task",
            message: `Task not found in this Session tree: ${ctx.params.taskID}`,
          })
        }),
      )
      .handle(
        "session.taskCancel",
        Effect.fn(function* (ctx) {
          const owner = yield* tasks.owner(ctx.params.sessionID)
          const cancelled = yield* tasks
            .cancelWithInterrupt({
              sessionID: owner?.rootSessionID ?? ctx.params.sessionID,
              taskID: ctx.params.taskID,
              expectedRevision: ctx.payload.expectedRevision,
              interrupt: (sessions) =>
                Effect.forEach(
                  sessions,
                  (sessionID) =>
                    execution.interrupt(sessionID).pipe(
                      Effect.timeoutOrElse({
                        duration: "5 seconds",
                        orElse: () =>
                          Effect.fail(
                            new ServiceUnavailableError({
                              message: `Subagent execution did not stop within 5 seconds: ${sessionID}`,
                              service: "session.task.cancel",
                            }),
                          ),
                      }),
                    ),
                  { concurrency: "unbounded", discard: true },
                ),
            })
            .pipe(
              Effect.catchTag(
                "SessionTask.NotFoundError",
                (error) =>
                  new InvalidRequestError({
                    kind: "session_task",
                    message: `Task not found: ${error.taskID}`,
                  }),
              ),
              Effect.catchTag(
                "SessionTask.ConflictError",
                (error) => new ConflictError({ resource: error.resource, message: error.message }),
              ),
              Effect.catchTag(
                "SessionTask.ActiveLimitError",
                (error) =>
                  new ConflictError({
                    resource: error.rootSessionID,
                    message: `Session already has ${error.maximum} active subagents`,
                  }),
              ),
            )
          return { data: taskDetail(cancelled.task) }
        }),
      )
      .handle(
        "session.teamBoard",
        Effect.fn(function* (ctx) {
          yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))))
          const owner = yield* tasks.owner(ctx.params.sessionID)
          return { data: yield* teamBoard.boardState(owner?.rootSessionID ?? ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.swarmRoom",
        Effect.fn(function* (ctx) {
          yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))))
          const room = yield* rooms.find(yield* rooms.rootFor(ctx.params.sessionID))
          if (!room)
            return yield* new SwarmRoom.NotFoundError({ resource: `session:${ctx.params.sessionID}` })
          return { data: yield* rooms.state(room.id) }
        }),
      )
      .handle(
        "session.swarmRoomEntries",
        Effect.fn(function* (ctx) {
          yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))))
          const room = yield* rooms.find(yield* rooms.rootFor(ctx.params.sessionID))
          if (!room)
            return yield* new SwarmRoom.NotFoundError({ resource: `session:${ctx.params.sessionID}` })
          return {
            data: yield* rooms.read(room.id, { after: ctx.query.after, limit: ctx.query.limit }),
          }
        }),
      )
      .handle(
        "session.swarmRoomPost",
        Effect.fn(function* (ctx) {
          yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))))
          const posted = yield* rooms.postHuman(ctx.params.sessionID, {
            text: ctx.payload.text,
            name: ctx.payload.name,
            replyTo: ctx.payload.replyTo,
          })
          for (const sessionID of posted.notified) yield* execution.wake(sessionID)
          return { data: posted.entry }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            // A user asked for this, so every remaining failure has to reach them with the
            // reason attached. The endpoint's error union is `SessionNotFoundError |
            // ServiceUnavailableError`, so the reason travels in the message rather than as a
            // distinct status; a silent 204 on a compaction that never happened would be worse.
            Effect.catch((error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session compaction failed: ${error.message}`,
                  service: "session.compact",
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
              Effect.catchTag(
                "SessionTranscriptAdoption.AdoptionError",
                (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
              ),
              Effect.catchTag(
                "SessionLegacyExecution.QuiescenceUnavailableError",
                (error) =>
                  new InvalidRequestError({
                    kind: "session_transcript_adoption",
                    message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
            Effect.catchTag(
              "SessionTranscriptAdoption.AdoptionError",
              (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
            ),
            Effect.catchTag(
              "SessionLegacyExecution.QuiescenceUnavailableError",
              (error) =>
                new InvalidRequestError({
                  kind: "session_transcript_adoption",
                  message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
            Effect.catchTag(
              "SessionTranscriptAdoption.AdoptionError",
              (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
            ),
            Effect.catchTag(
              "SessionLegacyExecution.QuiescenceUnavailableError",
              (error) =>
                new InvalidRequestError({
                  kind: "session_transcript_adoption",
                  message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("SessionRevert.GoalBoundaryError", (error) => Effect.fail(revertGoalConflict(error))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "SessionTranscriptAdoption.AdoptionError",
                (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
              ),
              Effect.catchTag(
                "SessionLegacyExecution.QuiescenceUnavailableError",
                (error) =>
                  new InvalidRequestError({
                    kind: "session_transcript_adoption",
                    message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.pendingInputs",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.pendingInputs(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.inputStatus",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .inputStatus({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.inputSteer",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .steerPendingInput({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.inputCancel",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .cancelPendingInput({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
              .pipe(
                Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.outbox",
        Effect.fn(function* (ctx) {
          return yield* session
            .outbox({
              sessionID: ctx.params.sessionID,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
              cursor: ctx.query.cursor,
              status: ctx.query.status,
            })
            .pipe(
              Effect.map((page) => ({ data: page.items, next: page.next })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
                latest: page.latest,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.replayHistory",
        Effect.fn(function* (ctx) {
          const page = yield* session
            .replayHistory({
              sessionID: ctx.params.sessionID,
              cursor: ctx.query.cursor,
              anchor: ctx.query.anchor,
              direction: ctx.query.direction,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.catchTag(
                "SessionReplay.QueryError",
                (error) =>
                  new InvalidRequestError({
                    message: error.message,
                    kind: "session_replay_cursor",
                    field: "cursor",
                  }),
              ),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
          return { data: page.events, cursor: { previous: page.previousCursor, next: page.nextCursor } }
        }),
      )
      .handle(
        "session.events",
        Effect.fn(function* (ctx) {
          // Recovery has no process-boot sweep -- it only runs when a client asks for it. A
          // client that was already watching a session when the process died never remounts,
          // so it never re-probes `session.resume`; all it does is reattach this stream. Settle
          // stale work here too, otherwise a turn orphaned mid tool call stays non-terminal and
          // the session renders as "working" indefinitely.
          //
          // Safe to repeat: `recover` is serialized on the per-session lock, returns `running`
          // without touching anything while this process still owns the turn, and is a no-op
          // once the tail is terminal. Best-effort by design -- a session whose recovery cannot
          // run (adoption failure, undecodable tail) must still be able to stream its events,
          // and `session.resume` remains the path that reports that failure to the caller.
          yield* session.recover(ctx.params.sessionID).pipe(Effect.catchCause(() => Effect.void))
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store, no-transform")),
          )
          return session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie)
        }),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionTask.OwnedSessionError", taskOwned),
            Effect.catchTag(
              "SessionTask.ConflictError",
              (error) => new ConflictError({ resource: error.resource, message: error.message }),
            ),
            Effect.catchTag(
              "SessionTask.ActiveLimitError",
              (error) =>
                new ConflictError({
                  resource: error.rootSessionID,
                  message: `Session already has ${error.maximum} active subagents`,
                }),
            ),
            Effect.catchTag(
              "Session.InterruptionTimeoutError",
              (error) =>
                new ServiceUnavailableError({
                  message: `Session execution did not stop within 5 seconds: ${error.sessionID}`,
                  service: "session.interrupt",
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params).pipe(
            Effect.catchTag(
              "SessionTranscriptAdoption.AdoptionError",
              (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
            ),
            Effect.catchTag(
              "SessionLegacyExecution.QuiescenceUnavailableError",
              (error) =>
                new InvalidRequestError({
                  kind: "session_transcript_adoption",
                  message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(sessionNotFound(error))),
          )
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)

function harnessError(error: SessionHarness.Error) {
  if (Schema.is(SessionHarness.NotFoundError)(error)) return sessionNotFound(error)
  if (Schema.is(SessionHarness.ProposalNotFoundError)(error))
    return new InvalidRequestError({
      kind: "session_harness_proposal",
      message: `Harness proposal not found: ${error.proposalID}`,
    })
  if (Schema.is(SessionHarness.InvalidStateError)(error))
    return new InvalidRequestError({ kind: "session_harness", message: error.message })
  return new ConflictError({
    message: error.message,
    resource: error.proposalID ?? error.sessionID,
  })
}

function sessionTerminalNotFound(error: SessionTerminal.NotFoundError) {
  return sessionNotFound(error)
}

function sessionNotFound(error: { readonly sessionID: string }) {
  return new SessionNotFoundError({
    sessionID: error.sessionID,
    message: `Session not found: ${error.sessionID}`,
  })
}

function goalConflict(error: {
  readonly goalID?: string | undefined
  readonly actualGoalID?: string | undefined
  readonly message: string
}) {
  return new ConflictError({
    message: error.message,
    resource: error.goalID ?? error.actualGoalID,
  })
}

function goalInvalidState(error: { readonly goalID: string; readonly message: string }) {
  return new ConflictError({ message: error.message, resource: error.goalID })
}

function revertGoalConflict(error: { readonly goalID: string; readonly messageID: string }) {
  return new ConflictError({
    message: `Cannot commit a revert that would remove the durable input for active goal ${error.goalID}`,
    resource: error.messageID,
  })
}

function taskSummary(task: SessionTaskV2.Info) {
  return {
    id: task.id,
    rootSessionID: task.rootSessionID,
    parentSessionID: task.parentSessionID,
    childSessionID: task.childSessionID,
    parentTaskID: task.parentTaskID,
    agent: AgentV2.ID.make(boundedTaskString(task.agent, SessionTaskResponseLimits.agentID)),
    model: boundedTaskModel(task.model),
    description: boundedTaskString(task.description, SessionTaskResponseLimits.summaryDescription),
    depth: task.depth,
    status: task.status,
    revision: task.revision,
    result:
      task.result === undefined ? undefined : boundedTaskString(task.result, SessionTaskResponseLimits.summaryResult),
    error: task.error === undefined ? undefined : boundedTaskString(task.error, SessionTaskResponseLimits.summaryError),
    time: task.time,
  }
}

function taskDetail(task: SessionTaskV2.Info) {
  return {
    id: task.id,
    rootSessionID: task.rootSessionID,
    parentSessionID: task.parentSessionID,
    childSessionID: task.childSessionID,
    parentTaskID: task.parentTaskID,
    actor: {
      sessionID: task.actor.sessionID,
      assistantMessageID: task.actor.assistantMessageID,
      toolCallID: boundedTaskString(task.actor.toolCallID, SessionTaskResponseLimits.actorToolCallID),
    },
    agent: AgentV2.ID.make(boundedTaskString(task.agent, SessionTaskResponseLimits.agentID)),
    model: boundedTaskModel(task.model),
    prompt: {
      text: boundedTaskString(task.prompt.text, SessionTaskResponseLimits.detailPrompt),
    },
    description: boundedTaskString(task.description, SessionTaskResponseLimits.detailDescription),
    depth: task.depth,
    status: task.status,
    revision: task.revision,
    authority: {
      parentPermissions: boundedTaskRuleset(task.authority.parentPermissions),
      ancestorPermissionSets: task.authority.ancestorPermissionSets
        .slice(0, SessionTaskResponseLimits.ancestorPermissionSets)
        .map(boundedTaskRuleset),
      childPermissions: boundedTaskRuleset(task.authority.childPermissions),
      hardPermissions: boundedTaskRuleset(task.authority.hardPermissions),
      writeRoots: task.authority.writeRoots
        .slice(0, SessionTaskResponseLimits.writeRoots)
        .map((root) => AbsolutePath.make(boundedTaskString(root, SessionTaskResponseLimits.writeRoot))),
      commands: task.authority.commands
        .slice(0, SessionTaskResponseLimits.commands)
        .map((command) => boundedTaskString(command, SessionTaskResponseLimits.command)),
    },
    result:
      task.result === undefined ? undefined : boundedTaskString(task.result, SessionTaskResponseLimits.detailResult),
    error: task.error === undefined ? undefined : boundedTaskString(task.error, SessionTaskResponseLimits.detailError),
    time: task.time,
  }
}

function boundedTaskRuleset(ruleset: SessionTaskV2.Authority["parentPermissions"]) {
  return ruleset.slice(0, SessionTaskResponseLimits.permissionRules).map((rule) => ({
    action: boundedTaskString(rule.action, SessionTaskResponseLimits.permissionAction),
    resource: boundedTaskString(rule.resource, SessionTaskResponseLimits.permissionResource),
    effect: rule.effect,
  }))
}

function boundedTaskModel(model: SessionTaskV2.Info["model"]) {
  if (!model) return
  return ModelV2.Ref.make({
    id: ModelV2.ID.make(boundedTaskString(model.id, SessionTaskResponseLimits.modelID)),
    providerID: ProviderV2.ID.make(boundedTaskString(model.providerID, SessionTaskResponseLimits.providerID)),
    variant: model.variant
      ? ModelV2.VariantID.make(boundedTaskString(model.variant, SessionTaskResponseLimits.variantID))
      : undefined,
  })
}

function boundedTaskString(value: string, maximum: number) {
  return value.length <= maximum ? value : value.slice(0, maximum)
}

function taskOwned(error: { readonly sessionID: string; readonly taskID: string; readonly message: string }) {
  return new InvalidRequestError({
    kind: "session_task_owned",
    message: `${error.message}: ${error.sessionID} is owned by ${error.taskID}`,
  })
}
