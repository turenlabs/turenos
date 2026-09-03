export * as TeamBoardTool from "./team-board"

import { TeamBoard as Contract } from "@turenlabs/schema/team-board"
import { ToolFailure } from "@turenlabs/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionExecutionControl } from "../session/execution-control"
import { SessionTaskV2 } from "../session/task"
import { TeamBoard } from "../team/board"
import { Tool } from "./tool"

export const postName = Contract.postToolName
export const readName = Contract.readToolName

const MAX_NOTES = 8
const MAX_BODY_LENGTH = 1_000
const MAX_EVIDENCE_LENGTH = 600
const BODY_TRUNCATED_SUFFIX = "… [body truncated]"
// Mirror the contract's limits at the tool boundary; without them a runaway analyst can write
// a multi-megabyte note that every sibling then pays for on read.
const TitleText = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))
const BodyText = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(131_072)))

const NoteView = Schema.Struct({
  note_id: Contract.ID,
  kind: Contract.Kind,
  title: Schema.String,
  body: Schema.String,
  evidence: Schema.String.pipe(Schema.optional),
  author_agent: AgentV2.ID,
  superseded_by: Contract.ID.pipe(Schema.optional),
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

const failure = (error: TeamBoard.Failure) => new ToolFailure({ message: error.message })

export function makeTools(deps: {
  readonly board: TeamBoard.Interface
  readonly permission: PermissionV2.Interface
  readonly tasks: SessionTaskV2.Interface
  readonly control: SessionExecutionControl.Interface
}) {
  const root = (context: Tool.Context) =>
    Effect.gen(function* () {
      const owner = yield* deps.tasks.owner(context.sessionID)
      return owner?.rootSessionID ?? context.sessionID
    })

  return {
    [postName]: Tool.make({
      description:
        "Share work with your sibling analysts by posting a durable note to the team's board. Parent agents receive the update at the next safe provider-turn boundary and can keep working without waiting. Use supersedes to CORRECT a teammate's note when you have better evidence, rather than posting an unconnected contradiction. Every claim should carry evidence so siblings can verify it.",
      input: Schema.Struct({
        kind: Contract.Kind,
        title: TitleText,
        body: BodyText,
        evidence: BodyText.pipe(Schema.optional),
        supersedes: Contract.ID.pipe(Schema.optional),
      }),
      output: Schema.Struct({
        note_id: Contract.ID,
        kind: Contract.Kind,
        title: Schema.String,
        superseded: Contract.ID.pipe(Schema.optional),
        parent_notified: Schema.Boolean,
      }),
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* assertPermission(deps.permission, postName, [input.kind], context)
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const owner = yield* deps.tasks.owner(context.sessionID)
              const note = yield* deps.board
                .post({
                  rootSessionID: yield* root(context),
                  authorSessionID: context.sessionID,
                  ...(owner ? { parentSessionID: owner.parentSessionID } : {}),
                  authorAgent: context.agent,
                  kind: input.kind,
                  title: input.title,
                  body: input.body,
                  evidence: input.evidence,
                  supersedes: input.supersedes,
                })
                .pipe(Effect.mapError(failure))
              const notification = owner
                ? yield* deps.tasks
                    .notifyParent({
                      taskID: owner.id,
                      text: TeamBoard.parentUpdateText(note),
                      messageID: TeamBoard.parentNotificationID(note),
                      source: "subagent_board",
                      allowTerminal: true,
                    })
                    .pipe(
                      Effect.catchTag("SessionTask.NotFoundError", () => Effect.succeed(undefined)),
                      Effect.catchTag("SessionTask.ConflictError", () => Effect.succeed(undefined)),
                    )
                : undefined
              if (notification?.admitted === true) {
                yield* deps.control.wakeAdvisory?.(notification.sessionID) ?? Effect.void
                yield* deps.board.markParentNotified(note.id).pipe(Effect.mapError(failure))
              } else if (owner !== undefined) {
                yield* deps.control.retry?.(owner.parentSessionID) ?? Effect.void
              }
              return {
                note_id: note.id,
                kind: note.kind,
                title: note.title,
                superseded: note.supersedes,
                parent_notified: notification?.admitted === true,
              }
            }),
          )
        }),
    }),
    [readName]: Tool.make({
      description:
        "Read the team's shared board BEFORE probing or testing anything. This prevents repeating a sibling's work and shows findings that have already been refuted. Results are newest-first pages rendered oldest-to-newest; pass next_cursor as cursor to read the previous page. By default, only current notes are returned; use include_superseded to inspect corrected history.",
      input: Schema.Struct({
        kind: Contract.Kind.pipe(Schema.optional),
        include_superseded: Schema.Boolean.pipe(Schema.optional),
        cursor: Contract.ID.pipe(Schema.optional),
      }),
      output: Schema.Struct({
        notes: Schema.Array(NoteView).pipe(Schema.check(Schema.isMaxLength(MAX_NOTES))),
        total: Schema.Number,
        next_cursor: Contract.ID.pipe(Schema.optional),
      }),
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* assertPermission(deps.permission, readName, [input.kind ?? "*"], context)
          const notes = (yield* deps.board.list(yield* root(context)).pipe(Effect.mapError(failure))).toSorted(
            (left, right) => left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
          )
          const end = input.cursor === undefined ? notes.length : notes.findIndex((note) => note.id === input.cursor)
          if (end < 0) return yield* new ToolFailure({ message: `Board cursor not found: ${input.cursor}` })
          const filtered = notes.filter(
            (note) =>
              (input.kind === undefined || note.kind === input.kind) &&
              (input.include_superseded === true || note.supersededBy === undefined),
          )
          const visible = new Set(filtered.map((note) => note.id))
          const candidates = notes.slice(0, end).filter((note) => visible.has(note.id))
          const bounded = candidates.slice(-MAX_NOTES).map((note) => ({
            note_id: note.id,
            kind: note.kind,
            title: note.title,
            body:
              note.body.length <= MAX_BODY_LENGTH
                ? note.body
                : `${note.body.slice(0, MAX_BODY_LENGTH - BODY_TRUNCATED_SUFFIX.length)}${BODY_TRUNCATED_SUFFIX}`,
            evidence:
              note.evidence === undefined
                ? undefined
                : note.evidence.length <= MAX_EVIDENCE_LENGTH
                  ? note.evidence
                  : `${note.evidence.slice(0, MAX_EVIDENCE_LENGTH - BODY_TRUNCATED_SUFFIX.length)}${BODY_TRUNCATED_SUFFIX}`,
            author_agent: note.authorAgent,
            superseded_by: note.supersededBy,
          }))
          return {
            notes: bounded,
            total: filtered.length,
            ...(candidates.length > MAX_NOTES ? { next_cursor: bounded[0].note_id } : {}),
          }
        }),
    }),
  } satisfies Readonly<Record<string, Tool.AnyTool>>
}

export interface Interface {
  readonly forExecution: (input: {
    readonly control: SessionExecutionControl.Interface
  }) => Effect.Effect<Readonly<Record<string, Tool.AnyTool>>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/TeamBoardTool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const board = yield* TeamBoard.Service
    const permission = yield* PermissionV2.Service
    const tasks = yield* SessionTaskV2.Service
    return Service.of({
      forExecution: (input: { readonly control: SessionExecutionControl.Interface }) =>
        Effect.succeed(makeTools({ board, permission, tasks, control: input.control })),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [TeamBoard.node, PermissionV2.node, SessionTaskV2.node],
})
