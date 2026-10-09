import { realpathSync } from "node:fs"
import { dirname } from "node:path"
import { describe, expect } from "bun:test"
import { Team } from "@turenlabs/schema/team"
import { Effect, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamWorkspaceTool } from "@turenlabs/core/tool/team-workspace"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_team_workspace_tool_test")
const directory = AbsolutePath.make(realpathSync(import.meta.dirname))
const assertions: PermissionV2.AssertInput[] = []
let deniedAction: string | undefined
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === deniedAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      TeamWorkspace.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TeamWorkspaceTool.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)
const call = (name: string, input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const setup = (registry: ToolRegistry.Interface, team: TeamWorkspace.Interface) =>
  Effect.gen(function* () {
    deniedAction = undefined
    for (const handle of ["rae", "sam"]) {
      expect(
        yield* executeTool(
          registry,
          call(
            TeamWorkspaceTool.createTeammateName,
            {
              name: handle,
              handle,
              role: "Researcher",
              mission: "Check the evidence",
            },
            `call-create-${handle}`,
          ),
        ),
      ).toMatchObject({ type: "json", value: { directory: directory, handle } })
    }
    const state = yield* team.state()
    const config: Team.FactoryConfig = {
      outcome: "Prepare a report",
      parameters: { subject: "Tests" },
      constraints: "Use local evidence",
      acceptanceCriteria: "Report includes sources",
      directory: directory,
      coordinatorTeammateID: state.teammates[0]!.id,
      teammateIDs: state.teammates.map((mate) => mate.id),
    }
    return { roomID: state.room.id, config }
  })

const configure = (
  registry: ToolRegistry.Interface,
  input: { roomID: string; config: Team.FactoryConfig },
  id = "call-configure",
) => executeTool(registry, call(TeamWorkspaceTool.configureFactoryName, input, id))

describe("TeamWorkspaceTool", () => {
  it.effect("registers eleven deferred discoverable tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(registry)
      expect(definitions.map((tool) => tool.name).sort()).toEqual([
        "team_collaborate",
        "team_configure_factory",
        "team_create_room",
        "team_create_teammate",
        "team_inbox",
        "team_post",
        "team_read",
        "team_run_factory",
        "team_stop_factory",
        "team_update_teammate",
        "team_wait",
      ])
      const deferred = yield* registry.materialize({ deferred: { selected: new Set<string>() } })
      expect(deferred.definitions).toEqual([])
      expect(deferred.deferred.map((tool) => tool.name).sort()).toEqual(definitions.map((tool) => tool.name).sort())
    }),
  )

  it.effect("creates two teammates and saves config without tasks or runs", () =>
    Effect.gen(function* () {
      assertions.length = 0
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      expect(yield* configure(registry, input)).toMatchObject({
        type: "json",
        value: { factory: { config: input.config } },
      })
      const state = yield* team.state()
      expect(state.teammates).toHaveLength(2)
      expect(state.tasks).toEqual([])
      expect(state.factoryRuns).toEqual([])
      expect(yield* executeTool(registry, call(TeamWorkspaceTool.readName, {}))).toMatchObject({
        type: "json",
        value: { room: { id: input.roomID }, tasks: [] },
      })
      expect(assertions).toContainEqual(
        expect.objectContaining({
          action: TeamWorkspaceTool.configureFactoryName,
          resources: [input.roomID, directory],
          metadata: { resource: input.roomID, directory: directory },
          sessionID,
          agent: toolIdentity.agent,
          source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-configure" },
        }),
      )
    }),
  )

  it.effect("runs teammate post and collaboration tools with derived identity and target permissions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      const [{ id }] = (yield* team.postMessage({ id: "msg_tool_sender_task", text: "@rae start" })).tasks
      yield* team.claimTasks({ owner: "tool-sender" })
      const running = yield* team.startTask({ id, owner: "tool-sender" })
      const post = {
        ...call(
          TeamWorkspaceTool.postName,
          { text: "Progress update", replyTo: "msg_tool_sender_task" },
          "call-team-post",
        ),
        sessionID: SessionV2.ID.make(running.sessionID),
      }
      expect(yield* executeTool(registry, post)).toMatchObject({
        type: "json",
        value: { author: "rae", teammateID: (yield* team.state()).teammates[0]!.id },
      })
      const collaborate = {
        ...call(
          TeamWorkspaceTool.collaborateName,
          { targetHandle: "sam", text: "Check this item", replyTo: "msg_tool_sender_task" },
          "call-team-collaborate",
        ),
        sessionID: SessionV2.ID.make(running.sessionID),
      }
      expect(yield* executeTool(registry, collaborate)).toMatchObject({
        type: "json",
        value: { message: { author: "rae", replyTo: "msg_tool_sender_task" }, tasks: [{ status: "queued" }] },
      })
      const parentSession = SessionV2.ID.make(running.sessionID)
      expect(
        yield* executeTool(registry, { ...call(TeamWorkspaceTool.inboxName, {}), sessionID: parentSession }),
      ).toMatchObject({
        type: "json",
        value: { teammates: [{ handle: "rae" }, { handle: "sam" }], head: expect.any(Number), hasMore: false },
      })
      const roomHead = (yield* team.state({ roomID: input.roomID })).room.head
      expect(
        yield* executeTool(registry, {
          ...call(TeamWorkspaceTool.waitName, { after: roomHead, timeoutMs: 1 }, "call-wait-timeout"),
          sessionID: parentSession,
        }),
      ).toMatchObject({ type: "json", value: { messages: [], tasks: [], head: roomHead, timedOut: true } })
      const childID = (yield* team.state({ roomID: input.roomID })).tasks.find((task) => task.id !== id)!.id
      yield* team.claimTasks({ owner: "tool-child" })
      const child = yield* team.startTask({ id: childID, owner: "tool-child" })
      for (let index = 0; index < 101; index++)
        yield* team.postTeammateMessage({
          sessionID: running.sessionID,
          assistantMessageID: `msg_wait_page_assistant_${index}`,
          id: `msg_wait_page_${index}`,
          text: "Room activity",
        })
      yield* team.finishTask({ id: childID, owner: "tool-child", status: "succeeded", text: "Completed" })
      const waited = yield* executeTool(registry, {
        ...call(TeamWorkspaceTool.waitName, { taskIDs: [childID], after: 0, timeoutMs: 1000 }, "call-wait-terminal"),
        sessionID: parentSession,
      })
      expect(waited).toMatchObject({
        type: "json",
        value: { tasks: [{ id: childID, status: "succeeded" }], hasMore: true, timedOut: false },
      })
      if (waited.type === "json") {
        const waitValue = waited.value as {
          messages: ReadonlyArray<Team.Message>
          results: ReadonlyArray<Team.Message>
        }
        expect(waitValue.messages).toHaveLength(100)
        expect(waitValue.results).toHaveLength(1)
        expect(waitValue.results[0]!.text).toBe("Completed")
        expect(waitValue.results[0]!.seq).toBeGreaterThan(waitValue.messages.at(-1)!.seq)
      }
      expect(child.sessionID).toBeTruthy()
      yield* team.createRoom({ name: "Other room" })
      const foreign = yield* team.postMessage({
        roomID: (yield* team.state()).rooms.find((room) => room.name === "Other room")!.id,
        id: "msg_foreign_reply_target",
        text: "Not in this room",
      })
      expect(foreign.message.roomID).not.toBe(input.roomID)
      const ownInbox = yield* executeTool(registry, {
        ...call(TeamWorkspaceTool.inboxName, {}, "call-own-room-inbox"),
        sessionID: parentSession,
      })
      expect(ownInbox).toMatchObject({
        type: "json",
        value: { messages: expect.not.arrayContaining([expect.objectContaining({ id: "msg_foreign_reply_target" })]) },
      })
      const page = yield* team.conversation({ sessionID: parentSession })
      expect(page.inbox.hasMore).toBe(true)
      expect(page.inbox.messages[0]!.seq).toBe(1)
      expect(page.inbox.messages.at(-1)!.seq).toBe(100)
      const next = yield* team.conversation({ sessionID: parentSession, after: 100 })
      expect(next.inbox.hasMore).toBe(false)
      expect(next.inbox.messages[0]!.seq).toBe(101)
      expect(
        yield* executeTool(registry, {
          ...call(TeamWorkspaceTool.waitName, { taskIDs: ["job_not_delegated"], timeoutMs: 1 }, "call-not-child"),
          sessionID: parentSession,
        }),
      ).toMatchObject({ type: "error" })
      expect(
        yield* executeTool(registry, {
          ...call(
            TeamWorkspaceTool.postName,
            { text: "Invalid cross-room reply", replyTo: "msg_foreign_reply_target" },
            "call-cross-room-reply",
          ),
          sessionID: parentSession,
        }),
      ).toMatchObject({ type: "error" })
      expect(assertions).toContainEqual(
        expect.objectContaining({ action: TeamWorkspaceTool.collaborateName, resources: ["sam", directory] }),
      )
      const beforeDenied = yield* team.state()
      deniedAction = TeamWorkspaceTool.collaborateName
      expect(
        yield* executeTool(registry, {
          ...call(TeamWorkspaceTool.collaborateName, { targetHandle: "sam", text: "Denied" }, "call-team-denied"),
          sessionID: SessionV2.ID.make(running.sessionID),
        }),
      ).toMatchObject({ type: "error" })
      expect(yield* team.state()).toEqual(beforeDenied)
      deniedAction = undefined
      yield* team.editTeammate({
        id: beforeDenied.teammates.find((mate) => mate.handle === "sam")!.id,
        directory: dirname(directory),
      })
      deniedAction = "external_directory"
      expect(
        yield* executeTool(registry, {
          ...call(
            TeamWorkspaceTool.collaborateName,
            { targetHandle: "sam", text: "External target" },
            "call-team-external",
          ),
          sessionID: SessionV2.ID.make(running.sessionID),
        }),
      ).toEqual({ type: "error", value: "Permission to run external_directory was declined" })
      expect((yield* team.state()).tasks).toHaveLength(beforeDenied.tasks.length)
      deniedAction = undefined
      expect(input.roomID).toBe(beforeDenied.room.id)
    }),
  )

  it.effect("explicitly queues one planning task and reconciles exact retries", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      yield* configure(registry, input)
      const request = call(
        TeamWorkspaceTool.runFactoryName,
        { roomID: input.roomID, request: "Run now" },
        "call-explicit-run",
      )
      const first = yield* executeTool(registry, request)
      expect(first).toMatchObject({ type: "json", value: { status: "running", phase: "plan" } })
      expect(yield* executeTool(registry, request)).toEqual(first)
      const state = yield* team.state()
      expect(state.factoryRuns).toHaveLength(1)
      expect(state.factoryRuns![0]!.id.length).toBeLessThanOrEqual(128)
      expect(state.tasks).toHaveLength(1)
      expect(state.tasks[0]).toMatchObject({ status: "queued", factoryRunID: state.factoryRuns![0]!.id })
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID, request: "Changed" }, "call-explicit-run"),
        ),
      ).toEqual({ type: "error", value: "Tool call identity was reused with a different request" })
      expect((yield* team.state()).tasks).toEqual(state.tasks)
      const stop = call(TeamWorkspaceTool.stopFactoryName, { roomID: input.roomID, runID: state.factoryRuns![0]!.id })
      expect(yield* executeTool(registry, stop)).toMatchObject({ type: "json", value: { status: "cancelled" } })
      expect((yield* team.state()).tasks[0]!.status).toBe("cancelled")
      const stopped = yield* team.state()
      yield* executeTool(registry, stop)
      expect(yield* team.state()).toEqual(stopped)
    }),
  )

  it.effect("uses a different run identity for another assistant message with the same call ID", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      yield* configure(registry, input)
      const request = call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID }, "call-reused")
      const first = yield* executeTool(registry, request)
      const firstRun = (yield* team.state()).factoryRuns![0]!
      yield* executeTool(
        registry,
        call(TeamWorkspaceTool.stopFactoryName, { roomID: input.roomID, runID: firstRun.id }),
      )
      const next = { ...request, assistantMessageID: SessionMessage.ID.make("msg_another_team_run") }
      const second = yield* executeTool(registry, next)
      expect(second).toMatchObject({ type: "json", value: { status: "running" } })
      expect(second).not.toEqual(first)
      expect(yield* executeTool(registry, next)).toEqual(second)
      const state = yield* team.state()
      expect(state.factoryRuns).toHaveLength(2)
      expect(new Set(state.factoryRuns!.map((run) => run.id)).size).toBe(2)
      expect(state.tasks).toHaveLength(2)
    }),
  )

  it.effect("permission denial leaves all Team state unchanged", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      yield* configure(registry, input)
      const state = yield* team.state()
      const requests = [
        call(TeamWorkspaceTool.readName, {}),
        call(TeamWorkspaceTool.createRoomName, { name: "Denied room" }),
        call(TeamWorkspaceTool.createTeammateName, {
          name: "Denied",
          handle: "denied",
          role: "Tester",
          mission: "Test",
          directory: "/outside",
        }),
        call(TeamWorkspaceTool.updateTeammateName, {
          teammateID: input.config.coordinatorTeammateID,
          changes: { mission: "Denied" },
        }),
        call(TeamWorkspaceTool.configureFactoryName, { ...input, config: { ...input.config, outcome: "Denied" } }),
        call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID }),
      ]
      for (const request of requests) {
        deniedAction = request.call.name
        expect(yield* executeTool(registry, request)).toEqual({
          type: "error",
          value: `Permission to run ${request.call.name} was declined`,
        })
        expect(yield* team.state()).toEqual(state)
      }
      deniedAction = undefined
      yield* executeTool(registry, call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID }, "call-allowed-run"))
      const running = yield* team.state()
      deniedAction = TeamWorkspaceTool.stopFactoryName
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.stopFactoryName, { roomID: input.roomID, runID: running.factoryRuns![0]!.id }),
        ),
      ).toEqual({ type: "error", value: "Permission to run team_stop_factory was declined" })
      expect(yield* team.state()).toEqual(running)
      expect(assertions).toContainEqual(
        expect.objectContaining({
          action: TeamWorkspaceTool.createTeammateName,
          resources: [input.roomID, "/outside"],
          metadata: { resource: input.roomID, directory: "/outside" },
        }),
      )
      deniedAction = undefined
    }),
  )

  it.effect("requires external_directory even when Team actions are allowed", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      const external = dirname(directory)
      const before = yield* team.state()
      assertions.length = 0
      deniedAction = "external_directory"
      const requests = [
        call(TeamWorkspaceTool.createTeammateName, {
          name: "External",
          handle: "external",
          role: "Tester",
          mission: "Test",
          directory: external,
        }),
        call(TeamWorkspaceTool.updateTeammateName, {
          teammateID: input.config.coordinatorTeammateID,
          changes: { directory: external },
        }),
        call(TeamWorkspaceTool.configureFactoryName, { ...input, config: { ...input.config, directory: external } }),
      ]
      for (const request of requests) {
        expect(yield* executeTool(registry, request)).toEqual({
          type: "error",
          value: "Permission to run external_directory was declined",
        })
        expect(yield* team.state()).toEqual(before)
      }
      expect(assertions.filter((assertion) => assertion.action === "external_directory")).toHaveLength(3)
      expect(assertions).toContainEqual(
        expect.objectContaining({
          action: "external_directory",
          resources: [`${external}/*`],
          sessionID,
          agent: toolIdentity.agent,
          source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-team_create_teammate" },
        }),
      )
      yield* team.configureFactory({ ...input, config: { ...input.config, directory: external } })
      const configured = yield* team.state()
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID }, "call-external-config"),
        ),
      ).toEqual({ type: "error", value: "Permission to run external_directory was declined" })
      expect(yield* team.state()).toEqual(configured)
      yield* team.configureFactory(input)
      yield* team.editTeammate({ id: input.config.coordinatorTeammateID, directory: external })
      const selected = yield* team.state()
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID }, "call-external-teammate"),
        ),
      ).toEqual({ type: "error", value: "Permission to run external_directory was declined" })
      expect(yield* team.state()).toEqual(selected)
      deniedAction = undefined
    }),
  )

  it.effect("rejects relative execution directory escapes before changes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      yield* setup(registry, team)
      const before = yield* team.state()
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.createTeammateName, {
            name: "Escape",
            handle: "escape",
            role: "Tester",
            mission: "Test",
            directory: "../outside",
          }),
        ),
      ).toEqual({ type: "error", value: "Invalid execution directory: relative_escape" })
      expect(yield* team.state()).toEqual(before)
    }),
  )

  it.effect("creates and updates an avatar without running work", () =>
    Effect.gen(function* () {
      deniedAction = undefined
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const avatar = ["........", "..0000..", ".011110.", ".012210.", ".011110.", "..0330..", "..0440..", "........"]
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.createTeammateName, {
            name: "Rae",
            handle: "rae",
            role: "Researcher",
            mission: "Check evidence",
            avatar,
          }),
        ),
      ).toMatchObject({ type: "json", value: { avatar } })
      const state = yield* team.state()
      const teammateID = state.teammates[0]!.id
      const updated = avatar.map((row) => row.replaceAll("1", "7"))
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.updateTeammateName, {
            teammateID,
            changes: { avatar: updated },
          }),
        ),
      ).toMatchObject({ type: "json", value: { avatar: updated } })
      const before = yield* team.state()
      expect(before.tasks).toEqual([])
      expect(before.factoryRuns).toEqual([])
      yield* executeTool(
        registry,
        call(TeamWorkspaceTool.updateTeammateName, { teammateID, changes: {} }, "call-noop-update"),
      )
      expect(yield* team.state()).toEqual(before)
      expect(
        yield* executeTool(
          registry,
          call(
            TeamWorkspaceTool.updateTeammateName,
            {
              teammateID,
              changes: { avatar: ["invalid"] },
            },
            "call-invalid-avatar",
          ),
        ),
      ).toMatchObject({ type: "error" })
      expect(yield* team.state()).toEqual(before)
    }),
  )

  it.effect("rejects invalid coordinator and cross-room teammate selection without effects", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const input = yield* setup(registry, team)
      const state = yield* team.state()
      expect(
        yield* configure(
          registry,
          { ...input, config: { ...input.config, coordinatorTeammateID: "missing" } },
          "call-invalid-coordinator",
        ),
      ).toEqual({ type: "error", value: "Invalid factory config" })
      expect(
        yield* configure(
          registry,
          {
            ...input,
            config: {
              ...input.config,
              teammateIDs: [input.config.coordinatorTeammateID, input.config.coordinatorTeammateID],
            },
          },
          "call-duplicate-selection",
        ),
      ).toEqual({ type: "error", value: "Invalid factory config" })
      expect(yield* team.state()).toEqual(state)
      expect(yield* executeTool(registry, call(TeamWorkspaceTool.createRoomName, { name: "Other" }))).toMatchObject({
        type: "json",
        value: { name: "Other" },
      })
      const other = (yield* team.state()).rooms.find((room) => room.name === "Other")!
      const before = yield* team.state()
      expect(yield* configure(registry, { roomID: other.id, config: input.config }, "call-cross-room")).toEqual({
        type: "error",
        value: "Factory teammates must belong to this room",
      })
      expect(yield* team.state()).toEqual(before)
      yield* configure(registry, input)
      yield* executeTool(registry, call(TeamWorkspaceTool.runFactoryName, { roomID: input.roomID }))
      const running = yield* team.state()
      expect(
        yield* executeTool(
          registry,
          call(TeamWorkspaceTool.stopFactoryName, { roomID: other.id, runID: running.factoryRuns![0]!.id }),
        ),
      ).toEqual({ type: "error", value: "Factory run does not belong to this room" })
      expect(yield* team.state()).toEqual(running)
    }),
  )
})
