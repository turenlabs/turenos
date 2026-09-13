export * as HandoffTool from "./handoff"

import { ToolFailure } from "@turenlabs/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { SessionCreation } from "../session/creation"
import { SessionExecutionControl } from "../session/execution-control"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { SessionTaskV2 } from "../session/task"
import { Tool } from "./tool"

export const name = "handoff_session"

const Title = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))
const PromptText = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256_000)))

const Input = Schema.Struct({
  title: Title.annotate({ description: "Short title for the new top-level session." }),
  prompt: PromptText.annotate({
    description:
      "A complete standalone continuation brief: objective, progress, decisions, relevant files, checks run, blockers, and next steps.",
  }),
  project: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional absolute project directory for the new session. Omit to use this session's directory.",
  }),
})

const Output = Schema.Struct({
  session_id: SessionSchema.ID,
  message_id: SessionMessage.ID,
  title: Schema.String,
  directory: Schema.String,
})

export interface Interface {
  readonly forExecution: (input: {
    readonly control: SessionExecutionControl.Interface
    readonly model: ModelV2.Ref
    readonly taskOwned: boolean
  }) => Effect.Effect<Readonly<Record<string, Tool.AnyTool>>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/HandoffTool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const events = yield* EventV2.Service
    const filesystem = yield* FSUtil.Service
    const creation = yield* SessionCreation.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const tasks = yield* SessionTaskV2.Service

    return Service.of({
      forExecution: ({ control, model, taskOwned }) =>
        Effect.gen(function* () {
          if (taskOwned) return {} as Readonly<Record<string, Tool.AnyTool>>
          const available: Readonly<Record<string, Tool.AnyTool>> = {
            [name]: Tool.make({
              deferred: true,
              description:
                "Create a new top-level TurenOS session in the current project or an explicitly supplied project directory with a durable continuation brief and start it immediately. This is a full left-nav session, not a subagent child. Use once when the current work should continue in a separate session.",
              input: Input,
              output: Output,
              retryableError: true,
              execute: (input, context) =>
                Effect.gen(function* () {
                  if (yield* tasks.isTaskOwned(context.sessionID))
                    return yield* new ToolFailure({ message: "handoff_session is unavailable in task-owned sessions" })
                  const project = input.project?.trim()
                  if (input.project !== undefined && !project)
                    return yield* new ToolFailure({ message: "Handoff project cannot be empty" })
                  const target = project
                    ? yield* Effect.gen(function* () {
                        const resolved = yield* mutation
                          .resolve({ path: project, kind: "directory" })
                          .pipe(
                            Effect.mapError(
                              () => new ToolFailure({ message: `Unable to resolve handoff project: ${project}` }),
                            ),
                          )
                        const info = yield* filesystem
                          .stat(resolved.canonical)
                          .pipe(
                            Effect.mapError(
                              () => new ToolFailure({ message: `Handoff project is unavailable: ${project}` }),
                            ),
                          )
                        if (info.type !== "Directory")
                          return yield* new ToolFailure({ message: `Handoff project is not a directory: ${project}` })
                        if (resolved.externalDirectory)
                          yield* permission
                            .assert({
                              ...LocationMutation.externalDirectoryPermission(resolved.externalDirectory),
                              sessionID: context.sessionID,
                              agent: context.agent,
                              source: {
                                type: "tool",
                                messageID: context.assistantMessageID,
                                callID: context.toolCallID,
                              },
                            })
                            .pipe(
                              Effect.mapError(
                                () => new ToolFailure({ message: "Permission denied: external_directory" }),
                              ),
                            )
                        return { directory: AbsolutePath.make(resolved.canonical), workspaceID: undefined }
                      })
                    : { directory: location.directory, workspaceID: location.workspaceID }
                  yield* permission
                    .assert({
                      action: name,
                      resources: [target.directory],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool",
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      },
                      metadata: { title: input.title.trim() },
                    })
                    .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: handoff_session" })))

                  const title = input.title.trim()
                  const brief = input.prompt.trim()
                  if (!title) return yield* new ToolFailure({ message: "Handoff title cannot be empty" })
                  if (!brief) return yield* new ToolFailure({ message: "Handoff prompt cannot be empty" })

                  return yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const key = createHash("sha256")
                        .update(`${context.sessionID}:${context.assistantMessageID}:${context.toolCallID}`)
                        .digest("hex")
                      const sessionID = SessionSchema.ID.make(`ses_handoff_${key}`)
                      const messageID = SessionMessage.ID.make(`msg_handoff_${key}`)
                      const prompt = Prompt.make({ text: brief })
                      const created = yield* creation.create({
                        id: sessionID,
                        agent: context.agent,
                        model,
                        title,
                        location: target,
                      })
                      if (
                        created.parentID !== undefined ||
                        created.location.directory !== target.directory ||
                        created.location.workspaceID !== target.workspaceID ||
                        created.agent !== context.agent ||
                        created.title !== title ||
                        created.model?.providerID !== model.providerID ||
                        created.model?.id !== model.id ||
                        (created.model?.variant ?? "default") !== (model.variant ?? "default")
                      )
                        return yield* new ToolFailure({ message: "Handoff identity conflict" })

                      const admitted = yield* SessionInput.admit(db, events, {
                        id: messageID,
                        sessionID,
                        prompt,
                        delivery: "steer",
                        agent: context.agent,
                        model,
                        kind: "prompt",
                        location: target,
                      })
                      if (
                        !SessionInput.equivalent(admitted, {
                          sessionID,
                          prompt,
                          delivery: "steer",
                          agent: context.agent,
                          model,
                        })
                      )
                        return yield* new ToolFailure({ message: "Handoff identity conflict" })
                      yield* control.wake(sessionID)
                      return {
                        session_id: sessionID,
                        message_id: messageID,
                        title,
                        directory: target.directory,
                      }
                    }),
                  )
                }),
            }),
          }
          return available
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    FSUtil.node,
    Location.node,
    LocationMutation.node,
    PermissionV2.node,
    SessionCreation.node,
    SessionTaskV2.node,
  ],
})
