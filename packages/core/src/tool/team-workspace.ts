export * as TeamWorkspaceTool from "./team-workspace"

import { createHash } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Team } from "@turenlabs/schema/team"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { TeamWorkspace } from "../team/workspace"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const readName = "team_read"
export const createRoomName = "team_create_room"
export const createTeammateName = "team_create_teammate"
export const updateTeammateName = "team_update_teammate"
export const configureFactoryName = "team_configure_factory"
export const runFactoryName = "team_run_factory"
export const stopFactoryName = "team_stop_factory"
export const postName = "team_post"
export const collaborateName = "team_collaborate"

const text = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(max)))
const roomID = text(256)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const team = yield* TeamWorkspace.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service

    const resolveDirectory = (directory: string, context: Tool.Context) =>
      Effect.gen(function* () {
        const target = yield* mutation
          .resolve({ path: directory, kind: "directory" })
          .pipe(Effect.mapError(toolFailure))
        if (target.externalDirectory)
          yield* permission
            .assert({
              ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
              metadata: PermissionV2.mutationMetadata([target.canonical]),
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            .pipe(
              Effect.mapError(() => new ToolFailure({ message: "Permission to run external_directory was declined" })),
            )
        return target.canonical
      })

    const assert = (action: string, resource: string, directory: string, context: Tool.Context) =>
      permission
        .assert({
          action,
          resources: [resource, directory],
          save: ["*"],
          metadata: { resource, directory },
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission to run ${action} was declined` })))

    yield* tools
      .register({
        [readName]: Tool.make({
          deferred: true,
          description:
            "Read Team rooms, teammates, factory config, tasks, and recent runs. Omit roomID for the default room. Read before setup. This does not run a factory.",
          input: Schema.Struct({
            roomID: roomID.pipe(Schema.optional),
            limit: Schema.Int.pipe(
              Schema.check(Schema.isGreaterThanOrEqualTo(1)),
              Schema.check(Schema.isLessThanOrEqualTo(200)),
              Schema.optional,
            ),
          }),
          output: Team.State,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(readName, input.roomID ?? "trm_team", location.directory, context)
              return yield* team.state(input).pipe(Effect.mapError(toolFailure))
            }),
        }),
        [createRoomName]: Tool.make({
          deferred: true,
          description:
            "Create a Team room only when the user needs a separate room. The existing default room is sufficient for factory setup. This does not run work.",
          input: Schema.Struct({
            name: text(64),
            topic: Schema.String.pipe(Schema.check(Schema.isMaxLength(500)), Schema.optional),
          }),
          output: Team.Room,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(createRoomName, input.name, location.directory, context)
              return yield* team.createRoom(input).pipe(Effect.mapError(toolFailure))
            }),
        }),
        [createTeammateName]: Tool.make({
          deferred: true,
          description:
            "Create one teammate in a Team room. Supply name, handle, role, and mission. Omit roomID for the default room and directory for this Session directory. Avatar uses eight rows of eight characters: '.' is transparent and '0' through '7' are fixed palette indices. This does not create tasks or run a factory.",
          input: Team.CreateTeammate,
          output: Team.Teammate,
          execute: (input, context) =>
            Effect.gen(function* () {
              const directory = input.directory ?? location.directory
              yield* assert(createTeammateName, input.roomID ?? "trm_team", directory, context)
              const canonical = yield* resolveDirectory(directory, context)
              return yield* team.createTeammate({ ...input, directory: canonical }).pipe(Effect.mapError(toolFailure))
            }),
        }),
        [updateTeammateName]: Tool.make({
          deferred: true,
          description:
            "Update your own teammate profile, or another profile when the user requests it. Read team_read to find teammateID. Set changes.avatar to eight rows of eight characters. '.' is transparent; '0' through '7' select the fixed palette. Omitted fields stay unchanged. This does not run a factory.",
          input: Schema.Struct({ teammateID: text(256), changes: Team.EditTeammate }),
          output: Team.Teammate,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(
                updateTeammateName,
                input.teammateID,
                input.changes.directory ?? location.directory,
                context,
              )
              const current = yield* team.getTeammate(input.teammateID).pipe(Effect.mapError(toolFailure))
              if (input.changes.directory === undefined && current.directory !== location.directory)
                yield* assert(updateTeammateName, input.teammateID, current.directory, context)
              if (Object.keys(input.changes).length === 0) return current
              const directory = yield* resolveDirectory(input.changes.directory ?? current.directory, context)
              return yield* team
                .editTeammate({ ...input.changes, directory, id: input.teammateID })
                .pipe(Effect.mapError(toolFailure))
            }),
        }),
        [configureFactoryName]: Tool.make({
          deferred: true,
          description:
            "Save factory config only. Select teammates from this room and include the coordinator in teammateIDs. Supply the execution directory. This never starts a run or creates tasks. Use team_run_factory only for an explicit user request to run.",
          input: Schema.Struct({ roomID, config: Team.FactoryConfig }),
          output: Team.Room,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(configureFactoryName, input.roomID, input.config.directory, context)
              const directory = yield* resolveDirectory(input.config.directory, context)
              return yield* team
                .configureFactory({ ...input, config: { ...input.config, directory } })
                .pipe(Effect.mapError(toolFailure))
            }),
        }),
        [runFactoryName]: Tool.make({
          deferred: true,
          description:
            "Start a configured factory only when the user explicitly requests a run. Setup or saving config is not a request to run. This durably queues a planning task for the native Team runtime. It does not start a background runner. Exact tool-call retries return the same run.",
          input: Schema.Struct({
            roomID,
            request: Schema.String.pipe(Schema.check(Schema.isMaxLength(8000)), Schema.optional),
          }),
          output: Team.FactoryRun,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(runFactoryName, input.roomID, location.directory, context)
              const state = yield* team.state({ roomID: input.roomID }).pipe(Effect.mapError(toolFailure))
              const directory = state.room.factory?.config.directory ?? location.directory
              if (directory !== location.directory) yield* assert(runFactoryName, input.roomID, directory, context)
              const selected = state.room.factory?.config.teammateIDs ?? []
              yield* Effect.forEach(
                new Set([
                  directory,
                  ...state.teammates.filter((mate) => selected.includes(mate.id)).map((mate) => mate.directory),
                ]),
                (directory) => resolveDirectory(directory, context),
                { discard: true },
              )
              // Match the native tool identity and keep the durable ID within Core's 128-character bound.
              const id = `tfr_tool_${createHash("sha256")
                .update(JSON.stringify([context.sessionID, context.assistantMessageID, context.toolCallID]))
                .digest("hex")}`
              return yield* team.startFactoryRun({ ...input, id }).pipe(Effect.mapError(toolFailure))
            }),
        }),
        [stopFactoryName]: Tool.make({
          deferred: true,
          description:
            "Cancel a factory run only when the user requests it. Supply its roomID and runID from team_read or team_run_factory. Finished runs remain unchanged.",
          input: Schema.Struct({ roomID, runID: text(128) }),
          output: Team.FactoryRun,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(stopFactoryName, input.roomID, location.directory, context)
              const run = yield* team.getFactoryRun(input.runID).pipe(Effect.mapError(toolFailure))
              if (run.roomID !== input.roomID)
                return yield* new ToolFailure({ message: "Factory run does not belong to this room" })
              const state = yield* team.state({ roomID: input.roomID }).pipe(Effect.mapError(toolFailure))
              const directory = state.room.factory?.config.directory ?? location.directory
              if (directory !== location.directory) yield* assert(stopFactoryName, input.roomID, directory, context)
              return yield* team.cancelFactoryRun(input.runID).pipe(Effect.mapError(toolFailure))
            }),
        }),
        [postName]: Tool.make({
          deferred: true,
          description:
            "Post a message to your own Team room without assigning work. Your teammate identity and room come from the running Team task. Completed task results are published automatically.",
          input: Schema.Struct({ text: text(8000) }),
          output: Team.Message,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(postName, "own-room", location.directory, context)
              const id = `msg_tool_${createHash("sha256")
                .update(JSON.stringify([context.sessionID, context.assistantMessageID, context.toolCallID]))
                .digest("hex")}`
              return yield* team
                .postTeammateMessage({
                  ...input,
                  assistantMessageID: context.assistantMessageID,
                  id,
                  sessionID: context.sessionID,
                })
                .pipe(Effect.mapError(toolFailure))
            }),
        }),
        [collaborateName]: Tool.make({
          deferred: true,
          description:
            "Assign one bounded task to one active teammate in your own room. This explicitly queues one durable Team task. Your teammate identity and room come from the running Team task. Do not delegate work that needs approval or broader permissions.",
          input: Schema.Struct({ targetHandle: text(32), text: text(8000) }),
          output: Team.Posted,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* assert(collaborateName, "own-room", location.directory, context)
              const sender = yield* team.teammateForSession(context.sessionID).pipe(Effect.mapError(toolFailure))
              const state = yield* team.state({ roomID: sender.roomID }).pipe(Effect.mapError(toolFailure))
              const target = state.teammates.find((mate) => mate.handle === input.targetHandle)
              if (!target)
                return yield* new ToolFailure({ message: `Teammate @${input.targetHandle} not found in your room` })
              yield* assert(collaborateName, input.targetHandle, target.directory, context)
              const directory = yield* resolveDirectory(target.directory, context)
              const id = `msg_tool_${createHash("sha256")
                .update(JSON.stringify([context.sessionID, context.assistantMessageID, context.toolCallID]))
                .digest("hex")}`
              return yield* team
                .collaborate({
                  ...input,
                  assistantMessageID: context.assistantMessageID,
                  directory,
                  id,
                  sessionID: context.sessionID,
                })
                .pipe(Effect.mapError(toolFailure))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

function toolFailure(error: unknown) {
  if (error instanceof LocationMutation.PathError)
    return new ToolFailure({ message: `Invalid execution directory: ${error.reason}` })
  if (
    error instanceof Team.InvalidRequestError ||
    error instanceof Team.NotFoundError ||
    error instanceof Team.ConflictError
  )
    return new ToolFailure({ message: error.message })
  return new ToolFailure({ message: "Team workspace operation failed" })
}

export const node = makeLocationNode({
  name: "tool/team-workspace",
  layer,
  deps: [ToolRegistry.node, TeamWorkspace.node, PermissionV2.node, Location.node, LocationMutation.node],
})
