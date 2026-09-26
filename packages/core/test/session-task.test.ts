import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionRunner } from "@turenlabs/core/session/runner"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionInputTable, SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { TeamBoard } from "@turenlabs/core/team/board"
import {
  SessionTaskActorClaimTable,
  SessionTaskOperationTable,
  SessionTaskTable,
} from "@turenlabs/core/session/task.sql"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("/project")
const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (input) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCreation.node,
      SessionTaskV2.node,
      TeamBoard.node,
    ]),
    [[ProjectV2.node, projects]],
  ),
)
const executionRunner: { run: SessionRunner.Interface["run"] } = {
  run: () => Effect.die(new Error("real execution test runner was not configured")),
}
const executionRunnerLayer = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    run: (input) => executionRunner.run(input),
    compact: () => Effect.die(new Error("real execution test runner does not compact")),
  }),
)
const executionLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => {
    // SessionExecutionLocal requests only SessionRunner from this isolated test map.
    return executionRunnerLayer as Layer.Layer<LocationServices>
  }),
)
const realExecutionIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCreation.node,
      SessionTaskV2.node,
      SessionExecutionLocal.node,
    ]),
    [
      [ProjectV2.node, projects],
      [LocationServiceMap.node, executionLocations],
    ],
  ),
)

const authority = SessionTaskV2.Authority.make({
  parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
  ancestorPermissionSets: [],
  childPermissions: [{ action: "edit", resource: "*", effect: "allow" }],
  hardPermissions: [{ action: "edit", resource: "*", effect: "deny" }],
  writeRoots: [directory],
  commands: ["bun test"],
})

const setup = Effect.fnUntraced(function* (suffix: string) {
  const { db } = yield* Database.Service
  const parentSessionID = SessionSchema.ID.make(`ses_task_parent_${suffix}`)
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: suffix,
      directory,
      title: suffix,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return parentSessionID
})

const actor = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  suffix: string,
  tool: "spawn_agent" | "spawn_agents" | "send_agent" | "interrupt_agent" = "spawn_agent",
) {
  const assistantMessageID = SessionMessage.ID.make(`msg_task_actor_${suffix}`)
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(Date.now()),
    agent: "build",
    model,
  })
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID,
    assistantMessageID,
    callID: `call_${suffix}`,
    timestamp: DateTime.makeUnsafe(Date.now()),
    name: tool,
  })
  yield* events.publish(SessionEvent.Tool.Input.Ended, {
    sessionID,
    assistantMessageID,
    callID: `call_${suffix}`,
    timestamp: DateTime.makeUnsafe(Date.now()),
    text: "{}",
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID,
    assistantMessageID,
    callID: `call_${suffix}`,
    timestamp: DateTime.makeUnsafe(Date.now()),
    tool,
    input: {},
    provider: { executed: false },
  })
  return SessionTaskV2.Actor.make({
    sessionID,
    assistantMessageID,
    toolCallID: `call_${suffix}`,
  })
})

const spawnInput = (actor: SessionTaskV2.Actor, suffix: string, activeLimit?: number): SessionTaskV2.SpawnInput => ({
  actor,
  agent: AgentV2.ID.make("explore"),
  model,
  prompt: Prompt.make({ text: `Inspect ${suffix}` }),
  description: `Task ${suffix}`,
  authority,
  ...(activeLimit === undefined ? {} : { activeLimit }),
})

describe("SessionTaskV2", () => {
  // The child Session's prompt is admitted from this global service, which has
  // no Location.Service in context, so the admission frame would publish
  // unlocated and be dropped by every per-instance event stream — the child's
  // first message would never reach a live client. See the filter in
  // packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
  it.effect("locates the child prompt admission a spawn publishes from the global fiber", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("admission_location")
      const tasks = yield* SessionTaskV2.Service
      const events = yield* EventV2.Service
      const seen: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => seen.push(event)))
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "admission_location"), "admission_location"))

      const admissions = seen.filter((event) => event.type === SessionEvent.PromptAdmitted.type)
      expect(admissions).toHaveLength(1)
      expect(admissions[0]!.location?.directory).toBe(directory)
    }),
  )

  it.effect("records spawn intent before a deterministic child and reconciles exact retries", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("spawn")
      const input = spawnInput(yield* actor(parentSessionID, "spawn"), "spawn")
      const tasks = yield* SessionTaskV2.Service

      const created = yield* tasks.spawn(input)
      const retried = yield* tasks.spawn(input)

      expect(created.wake).toBe(true)
      expect(retried).toEqual({ ...created, wake: false })
      expect(created.task).toMatchObject({
        rootSessionID: parentSessionID,
        parentSessionID,
        parentTaskID: undefined,
        depth: 1,
        status: "running",
        revision: 1,
        agent: "explore",
        authority,
      })
      expect(created.task.id.startsWith("tsk_")).toBe(true)
      expect(created.operation.id.startsWith("tso_")).toBe(true)
      expect(created.operation.status).toBe("applied")
      expect(created.operation.messageID?.startsWith("msg_")).toBe(true)

      const child = yield* (yield* SessionStore.Service).get(created.task.childSessionID)
      expect(child).toMatchObject({
        id: created.task.childSessionID,
        parentID: parentSessionID,
        agent: "explore",
        model,
        location: { directory },
      })
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, created.operation.messageID!))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        session_id: created.task.childSessionID,
        promoted_seq: null,
        time_cancelled: null,
      })
      expect(yield* tasks.list({ rootSessionID: parentSessionID })).toEqual([created.task])
    }),
  )

  it.effect("admits a durable advisory update to the parent without waiting for the child", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("parent_update")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "parent_update"), "parent_update"))

      const notified = yield* tasks.notifyParent({
        taskID: created.task.id,
        text: "The child found a useful lead; continue the parent workstream.",
        source: "subagent_board",
        coalesce: true,
      })

      expect(notified).toEqual({ sessionID: parentSessionID, admitted: true })
      expect(
        yield* tasks.notifyParent({
          taskID: created.task.id,
          text: "A second lead is now available on the board.",
          source: "subagent_board",
          coalesce: true,
        }),
      ).toEqual({ sessionID: parentSessionID, admitted: false })
      const { db } = yield* Database.Service
      const pending = yield* SessionInput.pending(db, parentSessionID)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        sessionID: parentSessionID,
        delivery: "queue",
        prompt: { text: "The child found a useful lead; continue the parent workstream." },
      })
    }),
  )

  it.effect("admits each settle and direct advisory without coalescing them away", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("settle_no_coalesce")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "settle_no_coalesce"), "settle_no_coalesce"),
      )

      expect(
        yield* tasks.notifyParent({
          taskID: created.task.id,
          text: "First task reached a terminal state.",
          source: "subagent_settle",
        }),
      ).toEqual({ sessionID: parentSessionID, admitted: true })
      expect(
        yield* tasks.notifyParent({
          taskID: created.task.id,
          text: "Second task reached a terminal state.",
          source: "subagent_settle",
        }),
      ).toEqual({ sessionID: parentSessionID, admitted: true })
      expect(
        yield* tasks.notifyParent({
          taskID: created.task.id,
          text: "I need a decision on the approach.",
          source: "subagent_advisory",
        }),
      ).toEqual({ sessionID: parentSessionID, admitted: true })

      const { db } = yield* Database.Service
      const pending = yield* SessionInput.pending(db, parentSessionID)
      expect(pending.filter((input) => input.source !== "user")).toHaveLength(3)
    }),
  )

  it.effect("recovers a pending board update from a terminal child only with explicit opt-in", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("terminal_board_recovery")
      const tasks = yield* SessionTaskV2.Service
      const board = yield* TeamBoard.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "terminal_board_recovery"), "terminal_board_recovery"),
      )
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      yield* tasks.settleRun({ sessionID: created.task.childSessionID, status: "completed" })

      const note = yield* board.post({
        rootSessionID: parentSessionID,
        authorSessionID: created.task.childSessionID,
        parentSessionID,
        authorAgent: AgentV2.ID.make("explore"),
        kind: "finding",
        title: "Recovered finding",
        body: "The terminal child left a durable finding before the process stopped.",
      })

      expect(
        yield* tasks.notifyParent({
          taskID: created.task.id,
          text: "The terminal child finding is pending.",
          source: "subagent_board",
          coalesce: true,
        }),
      ).toBeUndefined()
      expect(yield* board.pendingParentNotes()).toEqual([note])

      const notification = yield* tasks.notifyParent({
        taskID: created.task.id,
        text: "The terminal child finding is now admitted.",
        messageID: TeamBoard.parentNotificationID(note),
        source: "subagent_board",
        coalesce: true,
        allowTerminal: true,
      })
      expect(notification).toEqual({ sessionID: parentSessionID, admitted: true })

      yield* SessionInput.promoteNextQueued(db, events, parentSessionID)
      expect(
        yield* tasks.notifyParent({
          taskID: created.task.id,
          text: "The terminal child finding is now admitted.",
          messageID: TeamBoard.parentNotificationID(note),
          source: "subagent_board",
          coalesce: true,
          allowTerminal: true,
        }),
      ).toEqual({ sessionID: parentSessionID, admitted: true })
      yield* board.markParentNotified(note.id)
      expect(yield* board.pendingParentNotes()).toEqual([])
    }),
  )

  it.effect("rejects a stable board notification ID that collides with another input", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("board_notification_collision")
      const tasks = yield* SessionTaskV2.Service
      const board = yield* TeamBoard.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "board_notification_collision"), "board_notification_collision"),
      )
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const note = yield* board.post({
        rootSessionID: parentSessionID,
        authorSessionID: created.task.childSessionID,
        parentSessionID,
        authorAgent: AgentV2.ID.make("explore"),
        kind: "finding",
        title: "Collision finding",
        body: "This note must not reuse another input's identity.",
      })
      const messageID = TeamBoard.parentNotificationID(note)
      yield* SessionInput.admit(db, events, {
        id: messageID,
        sessionID: parentSessionID,
        prompt: Prompt.make({ text: "An unrelated input" }),
        delivery: "queue",
        source: "user",
        kind: "prompt",
        location: { directory },
      })

      expect(
        yield* tasks
          .notifyParent({
            taskID: created.task.id,
            text: TeamBoard.parentUpdateText(note),
            messageID,
            source: "subagent_board",
            coalesce: true,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "SessionTask.ConflictError", resource: messageID })
      expect(yield* board.pendingParentNotes()).toEqual([note])
    }),
  )

  it.effect("delivers board notes left pending across a process restart", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("board_sweep")
      const tasks = yield* SessionTaskV2.Service
      const board = yield* TeamBoard.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "board_sweep"), "board_sweep"))

      // A pending note with no admitted input models a post that succeeded while
      // the notify fiber died, exactly what the construction-time sweep recovers.
      const note = yield* board.post({
        rootSessionID: parentSessionID,
        authorSessionID: created.task.childSessionID,
        parentSessionID,
        authorAgent: AgentV2.ID.make("explore"),
        kind: "finding",
        title: "Recovered lead",
        body: "The process stopped before the parent was told.",
      })
      expect(yield* board.pendingParentNotes()).toEqual([note])

      yield* tasks.deliverPendingParentNotifications()

      const { db } = yield* Database.Service
      const pending = yield* SessionInput.pending(db, parentSessionID)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        id: TeamBoard.parentNotificationID(note),
        sessionID: parentSessionID,
        delivery: "queue",
        source: "subagent_board",
      })
      expect(yield* board.pendingParentNotes()).toEqual([])

      // A note from a task that is already terminal is still resolved delivered:
      // the parent learns the outcome from the final report instead.
      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      yield* tasks.settleRun({ sessionID: created.task.childSessionID, status: "completed" })
      const late = yield* board.post({
        rootSessionID: parentSessionID,
        authorSessionID: created.task.childSessionID,
        parentSessionID,
        authorAgent: AgentV2.ID.make("explore"),
        kind: "finding",
        title: "Terminal lead",
        body: "The child finished before this note could be delivered.",
      })
      expect(yield* board.pendingParentNotes()).toEqual([late])

      yield* tasks.deliverPendingParentNotifications()

      expect(yield* board.pendingParentNotes()).toEqual([])
      expect(yield* SessionInput.pending(db, parentSessionID)).toHaveLength(1)
    }),
  )

  it.effect("keeps a task valid after its project is re-keyed by a git remote change", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("rekey")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "rekey"), "rekey"))

      // A project id is a hash of the git remote, so renaming the repository
      // gives the same directory a new one. Sessions created after the rename
      // carry the new id while their parents keep the old one.
      const { db } = yield* Database.Service
      const rekeyed = ProjectV2.ID.make("5f77a9ef77c296549085ea45a976dc7d9b7d4845")
      yield* db
        .insert(ProjectTable)
        .values({ id: rekeyed, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ project_id: rekeyed })
        .where(eq(SessionTable.id, created.task.childSessionID))
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      yield* tasks.settleRun({ sessionID: created.task.childSessionID, status: "completed" })
      expect((yield* tasks.get(created.task.id))?.status).toBe("completed")
    }),
  )

  it.effect("round-trips every persisted task and operation field losslessly", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("roundtrip")
      const tasks = yield* SessionTaskV2.Service
      const input = spawnInput(yield* actor(parentSessionID, "roundtrip"), "roundtrip")
      const created = yield* tasks.spawn(input)
      const stored = yield* tasks.spawn(input)

      expect(Schema.encodeSync(SessionTaskV2.Info)(stored.task)).toEqual(
        Schema.encodeSync(SessionTaskV2.Info)(created.task),
      )
      expect(Schema.encodeSync(SessionTaskV2.Operation)(stored.operation)).toEqual(
        Schema.encodeSync(SessionTaskV2.Operation)(created.operation),
      )
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.id, created.task.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        root_session_id: created.task.rootSessionID,
        parent_session_id: created.task.parentSessionID,
        child_session_id: created.task.childSessionID,
        actor_session_id: created.task.actor.sessionID,
        actor_assistant_message_id: created.task.actor.assistantMessageID,
        actor_tool_call_id: created.task.actor.toolCallID,
        prompt: created.task.prompt,
        description: created.task.description,
        parent_permissions: created.task.authority.parentPermissions,
        ancestor_permission_sets: created.task.authority.ancestorPermissionSets,
        child_permissions: created.task.authority.childPermissions,
        hard_permissions: created.task.authority.hardPermissions,
        write_roots: created.task.authority.writeRoots,
        commands: created.task.authority.commands,
      })
    }),
  )

  it.effect("rolls back malformed task events across every ownership and provenance boundary", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("hostile_projector")
      const otherParentSessionID = yield* setup("hostile_projector_other")
      const validActor = yield* actor(parentSessionID, "hostile_projector")
      const otherActor = yield* actor(otherParentSessionID, "hostile_projector_other")
      const wrongToolActor = SessionTaskV2.Actor.make({
        ...validActor,
        toolCallID: "call_not_recorded_as_spawn",
      })
      const wrongNameActor = yield* actor(parentSessionID, "hostile_projector_wrong_name", "send_agent")
      const now = DateTime.makeUnsafe(Date.now())
      const makeCandidate = (
        suffix: string,
        changes?: Partial<SessionTaskV2.Info>,
        operationChanges?: Partial<SessionTaskV2.Operation>,
      ) => {
        const task = SessionTaskV2.Info.make({
          id: SessionTaskV2.ID.create(),
          rootSessionID: parentSessionID,
          parentSessionID,
          childSessionID: SessionSchema.ID.create(),
          actor: validActor,
          agent: AgentV2.ID.make("explore"),
          model,
          prompt: Prompt.make({ text: `Hostile projector ${suffix}` }),
          description: `Hostile ${suffix}`.slice(0, SessionTaskV2.MAX_DESCRIPTION_LENGTH),
          depth: 1,
          status: "starting",
          revision: 0,
          authority,
          time: { created: now, updated: now },
          ...changes,
        })
        const operation = SessionTaskV2.Operation.make({
          id: SessionTaskV2.OperationID.create(),
          taskID: task.id,
          rootSessionID: task.rootSessionID,
          actor: task.actor,
          kind: "spawn",
          requestHash: "a".repeat(64),
          messageID: SessionMessage.ID.create(),
          prompt: task.prompt,
          status: "pending",
          time: { created: now, updated: now },
          ...operationChanges,
        })
        return { task, operation }
      }
      const candidates = [
        makeCandidate("actor_parent", { actor: otherActor }),
        makeCandidate("root", { rootSessionID: otherParentSessionID }),
        makeCandidate("task", undefined, { taskID: SessionTaskV2.ID.create() }),
        makeCandidate("depth", { depth: 2 }),
        makeCandidate("tool_identity", { actor: wrongToolActor }),
        makeCandidate("tool_name", { actor: wrongNameActor }),
      ]
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const taskEventType = EventV2.versionedType(SessionEvent.Task.Updated.type, 1)

      for (const candidate of candidates) {
        const before = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, taskEventType))
          .all()
          .pipe(Effect.orDie)
        const exit = yield* events
          .publish(SessionEvent.Task.Updated, {
            sessionID: candidate.task.rootSessionID,
            taskID: candidate.task.id,
            timestamp: now,
            task: candidate.task,
            operation: candidate.operation,
          })
          .pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(
          yield* db.select().from(EventTable).where(eq(EventTable.type, taskEventType)).all().pipe(Effect.orDie),
        ).toEqual(before)
        expect(
          yield* db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, candidate.task.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* db
            .select()
            .from(SessionTaskOperationTable)
            .where(eq(SessionTaskOperationTable.id, candidate.operation.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* db
            .select()
            .from(SessionTaskActorClaimTable)
            .where(eq(SessionTaskActorClaimTable.operation_id, candidate.operation.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
      }
    }),
  )

  it.effect("rejects envelope smuggling, standalone spawn operations, forged hashes, and saga-free transitions", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("hostile_updates")
      const tasks = yield* SessionTaskV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "hostile_updates_spawn"), "hostile_updates"),
      )
      const now = DateTime.makeUnsafe(Date.now())

      const envelope = yield* events
        .publish(SessionEvent.Task.Updated, {
          sessionID: parentSessionID,
          taskID: SessionTaskV2.ID.create(),
          timestamp: now,
          task: SessionTaskV2.Info.make({
            ...created.task,
            revision: created.task.revision + 1,
            time: { ...created.task.time, updated: now },
          }),
        })
        .pipe(Effect.exit)

      const spawnActor = yield* actor(parentSessionID, "hostile_updates_standalone_spawn")
      const standaloneSpawn = SessionTaskV2.Operation.make({
        id: SessionTaskV2.OperationID.create(),
        taskID: created.task.id,
        rootSessionID: parentSessionID,
        actor: spawnActor,
        kind: "spawn",
        requestHash: "a".repeat(SessionTaskV2.REQUEST_HASH_LENGTH),
        messageID: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "Do not attach this spawn to an existing task" }),
        status: "pending",
        time: { created: now, updated: now },
      })
      const standalone = yield* events
        .publish(SessionEvent.Task.OperationUpdated, {
          sessionID: parentSessionID,
          taskID: created.task.id,
          timestamp: now,
          operation: standaloneSpawn,
        })
        .pipe(Effect.exit)

      const sendActor = yield* actor(parentSessionID, "hostile_updates_hash", "send_agent")
      const forgedSend = SessionTaskV2.Operation.make({
        id: SessionTaskV2.OperationID.create(),
        taskID: created.task.id,
        rootSessionID: parentSessionID,
        actor: sendActor,
        kind: "send",
        requestHash: "b".repeat(SessionTaskV2.REQUEST_HASH_LENGTH),
        messageID: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "Forged request hash" }),
        status: "pending",
        time: { created: now, updated: now },
      })
      const before = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      const forged = yield* events
        .publish(SessionEvent.Task.OperationUpdated, {
          sessionID: parentSessionID,
          taskID: created.task.id,
          timestamp: now,
          operation: forgedSend,
        })
        .pipe(Effect.exit)
      const smuggled = yield* events
        .publish(SessionEvent.Task.Updated, {
          sessionID: parentSessionID,
          taskID: created.task.id,
          timestamp: now,
          task: SessionTaskV2.Info.make({
            ...created.task,
            revision: created.task.revision + 1,
            time: { ...created.task.time, updated: now },
          }),
          operation: SessionTaskV2.Operation.make({
            ...forgedSend,
            id: SessionTaskV2.OperationID.create(),
            taskID: SessionTaskV2.ID.create(),
          }),
        })
        .pipe(Effect.exit)

      const pendingCompletion = yield* events
        .publish(SessionEvent.Task.Updated, {
          sessionID: parentSessionID,
          taskID: created.task.id,
          timestamp: now,
          task: SessionTaskV2.Info.make({
            ...created.task,
            status: "completed",
            revision: created.task.revision + 1,
            time: { ...created.task.time, updated: now, completed: now },
          }),
        })
        .pipe(Effect.exit)

      expect(envelope._tag).toBe("Failure")
      expect(standalone._tag).toBe("Failure")
      expect(forged._tag).toBe("Failure")
      expect(smuggled._tag).toBe("Failure")
      expect(pendingCompletion._tag).toBe("Failure")
      expect(yield* tasks.get(created.task.id)).toEqual(created.task)
      expect(
        yield* db
          .select()
          .from(SessionTaskOperationTable)
          .where(eq(SessionTaskOperationTable.id, standaloneSpawn.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionTaskOperationTable)
          .where(eq(SessionTaskOperationTable.id, forgedSend.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual(before)

      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      const completed = yield* tasks.settle({
        taskID: created.task.id,
        expectedRevision: created.task.revision,
        status: "completed",
        result: "Done",
      })
      const revived = yield* events
        .publish(SessionEvent.Task.Updated, {
          sessionID: parentSessionID,
          taskID: completed.id,
          timestamp: now,
          task: SessionTaskV2.Info.make({
            ...completed,
            status: "running",
            revision: completed.revision + 1,
            result: undefined,
            time: { ...completed.time, updated: now, completed: undefined },
          }),
        })
        .pipe(Effect.exit)
      expect(revived._tag).toBe("Failure")
      expect(yield* tasks.get(created.task.id)).toEqual(completed)
    }),
  )

  it.effect("rejects changed reuse of one actor call identity", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("conflict")
      const input = spawnInput(yield* actor(parentSessionID, "conflict"), "conflict")
      const tasks = yield* SessionTaskV2.Service
      yield* tasks.spawn(input)

      const conflict = yield* tasks.spawn({ ...input, description: "Changed" }).pipe(Effect.flip)
      const kindConflict = yield* tasks
        .interrupt({ actor: input.actor, taskID: (yield* tasks.list({ rootSessionID: parentSessionID }))[0]!.id })
        .pipe(Effect.flip)

      expect(conflict).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: "Subagent operation identity was reused with a different request",
      })
      expect(kindConflict).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: "Subagent operation identity was reused with a different request",
      })
      expect(yield* tasks.list({ rootSessionID: parentSessionID })).toHaveLength(1)
    }),
  )

  it.effect("serializes concurrent exact spawn retries into one task and operation", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("concurrent")
      const input = spawnInput(yield* actor(parentSessionID, "concurrent"), "concurrent")
      const tasks = yield* SessionTaskV2.Service

      const results = yield* Effect.all([tasks.spawn(input), tasks.spawn(input)], { concurrency: "unbounded" })
      const { db } = yield* Database.Service

      expect(new Set(results.map((item) => item.task.id)).size).toBe(1)
      expect(results.filter((item) => item.wake)).toHaveLength(1)
      expect(yield* db.select().from(SessionTaskTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* db.select().from(SessionTaskOperationTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.effect("pages newest tasks by a strict bounded creation-time and ID cursor", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("pagination")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* Effect.forEach(
        ["first", "second", "third", "fourth"],
        (suffix) =>
          actor(parentSessionID, `pagination_${suffix}`).pipe(
            Effect.flatMap((value) => tasks.spawn(spawnInput(value, `pagination_${suffix}`))),
          ),
        { concurrency: 1 },
      )

      const first = yield* tasks.listPage({ rootSessionID: parentSessionID, limit: 2 })
      const second = yield* tasks.listPage({
        rootSessionID: parentSessionID,
        after: {
          timeCreated: DateTime.toEpochMillis(first.at(-1)!.time.created),
          id: first.at(-1)!.id,
        },
        limit: 2,
      })
      const exhausted = yield* tasks.listPage({
        rootSessionID: parentSessionID,
        after: {
          timeCreated: DateTime.toEpochMillis(second.at(-1)!.time.created),
          id: second.at(-1)!.id,
        },
        limit: Number.MAX_SAFE_INTEGER,
      })

      const newest = created.toReversed()
      expect(first.map((task) => task.id)).toEqual(newest.slice(0, 2).map((item) => item.task.id))
      expect(second.map((task) => task.id)).toEqual(newest.slice(2).map((item) => item.task.id))
      expect(new Set([...first, ...second].map((task) => task.id)).size).toBe(4)
      expect(exhausted).toEqual([])
    }),
  )

  it.effect("rejects oversized persistence and mismatched live tool provenance before writing", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("persistence_caps")
      const tasks = yield* SessionTaskV2.Service
      const descriptionInput = spawnInput(
        yield* actor(parentSessionID, "persistence_caps_description"),
        "persistence_caps_description",
      )
      const description = yield* tasks
        .spawn({
          ...descriptionInput,
          description: "x".repeat(SessionTaskV2.MAX_DESCRIPTION_LENGTH + 1),
        })
        .pipe(Effect.flip)
      const promptInput = spawnInput(
        yield* actor(parentSessionID, "persistence_caps_prompt"),
        "persistence_caps_prompt",
      )
      const prompt = yield* tasks
        .spawn({
          ...promptInput,
          prompt: Prompt.make({ text: "x".repeat(SessionTaskV2.MAX_PROMPT_BYTES) }),
        })
        .pipe(Effect.flip)
      const provenanceInput = spawnInput(
        yield* actor(parentSessionID, "persistence_caps_provenance", "send_agent"),
        "persistence_caps_provenance",
      )
      const provenance = yield* tasks.spawn(provenanceInput).pipe(Effect.flip)
      const agentInput = spawnInput(yield* actor(parentSessionID, "persistence_caps_agent"), "persistence_caps_agent")
      const agent = yield* tasks
        .spawn({
          ...agentInput,
          agent: AgentV2.ID.make("a".repeat(SessionTaskV2.MAX_AGENT_ID_LENGTH + 1)),
        })
        .pipe(Effect.flip)
      const modelInput = spawnInput(yield* actor(parentSessionID, "persistence_caps_model"), "persistence_caps_model")
      const oversizedModel = yield* tasks
        .spawn({
          ...modelInput,
          model: ModelV2.Ref.make({
            providerID: ProviderV2.ID.make("provider"),
            id: ModelV2.ID.make("m".repeat(SessionTaskV2.MAX_MODEL_ID_LENGTH + 1)),
          }),
        })
        .pipe(Effect.flip)

      expect(description).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: expect.stringContaining("description exceeds"),
      })
      expect(prompt).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: expect.stringContaining("prompt exceeds"),
      })
      expect(provenance).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: "Subagent operation actor is not a recorded tool call in the parent Session",
      })
      expect(agent).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: expect.stringContaining("agent identity exceeds"),
      })
      expect(oversizedModel).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: expect.stringContaining("model identity exceeds"),
      })
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.root_session_id, parentSessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])

      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "persistence_caps_result"), "persistence_caps_result"),
      )
      yield* SessionInput.promoteSteers(
        db,
        yield* EventV2.Service,
        created.task.childSessionID,
        Number.MAX_SAFE_INTEGER,
      )
      expect(
        yield* tasks
          .settle({
            taskID: created.task.id,
            expectedRevision: created.task.revision,
            status: "completed",
            result: "x".repeat(SessionTaskV2.MAX_RESULT_LENGTH + 1),
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: expect.stringContaining("result exceeds"),
      })
      expect(yield* tasks.get(created.task.id)).toMatchObject({ status: "running", revision: 1 })
    }),
  )

  it.effect("enforces prompt persistence limits in UTF-8 bytes", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("persistence_utf8")
      const tasks = yield* SessionTaskV2.Service
      const input = spawnInput(yield* actor(parentSessionID, "persistence_utf8"), "persistence_utf8")
      const failure = yield* tasks
        .spawn({
          ...input,
          prompt: Prompt.make({
            text: String.fromCharCode(0xe9).repeat(Math.ceil(SessionTaskV2.MAX_PROMPT_BYTES / 2)),
          }),
        })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionTask.ConflictError",
        message: expect.stringContaining("prompt exceeds"),
      })
    }),
  )

  it.effect("queues beyond the default active-child limit and requires orchestrate to nest", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("limits")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* Effect.forEach(
        Array.from({ length: SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT }, (_, index) => index),
        (index) =>
          actor(parentSessionID, `limit_${index}`).pipe(
            Effect.flatMap((value) => tasks.spawn(spawnInput(value, `limit_${index}`))),
          ),
        { concurrency: "unbounded" },
      )
      const next = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "limit_next"), "limit_next"))
      expect(next.wake).toBe(false)
      expect(next.task.status).toBe("queued")
      expect(next.operation.status).toBe("pending")

      const childActor = yield* actor(created[0]!.task.childSessionID, "nested")
      const nested = yield* tasks.spawn(spawnInput(childActor, "nested")).pipe(Effect.flip)
      expect(nested).toMatchObject({
        _tag: "SessionTask.OrchestrateError",
        sessionID: created[0]!.task.childSessionID,
      })
    }),
  )

  it.effect("queues at the configured active limit instead of the historical constant", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("configured_limit")
      const tasks = yield* SessionTaskV2.Service
      yield* Effect.forEach(
        Array.from({ length: 2 }, (_, index) => index),
        (index) =>
          actor(parentSessionID, `configured_${index}`).pipe(
            Effect.flatMap((value) => tasks.spawn(spawnInput(value, `configured_${index}`, 2))),
          ),
        { concurrency: 1, discard: true },
      )
      // The configured ceiling is two, so the third child proves the limit is
      // read rather than hardcoded.
      expect(
        (yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "configured_third"), "configured_third", 2)))
          .task.status,
      ).toBe("queued")
    }),
  )

  it.effect("clamps a configured active limit to the hard cap", () =>
    Effect.gen(function* () {
      expect(SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT).toBe(50)
      expect(SessionTaskV2.MAX_ACTIVE_PER_ROOT).toBe(50)
      expect(SessionTaskV2.resolveActiveLimit(undefined)).toBe(SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT)
      expect(SessionTaskV2.resolveActiveLimit(0)).toBe(SessionTaskV2.MIN_ACTIVE_PER_ROOT)
      expect(SessionTaskV2.resolveActiveLimit(-8)).toBe(SessionTaskV2.MIN_ACTIVE_PER_ROOT)
      expect(SessionTaskV2.resolveActiveLimit(6)).toBe(6)
      expect(SessionTaskV2.resolveActiveLimit(1_000)).toBe(SessionTaskV2.MAX_ACTIVE_PER_ROOT)

      const parentSessionID = yield* setup("raised_limit")
      const tasks = yield* SessionTaskV2.Service
      // The clamped request for one thousand still admits work below the cap.
      yield* Effect.forEach(
        Array.from({ length: 5 }, (_, index) => index),
        (index) =>
          actor(parentSessionID, `raised_${index}`).pipe(
            Effect.flatMap((value) => tasks.spawn(spawnInput(value, `raised_${index}`, 1_000))),
          ),
        { concurrency: 1, discard: true },
      )
      expect(yield* tasks.listActive(parentSessionID)).toHaveLength(5)
    }),
  )

  it.effect("enforces active capacity inside the projector when a terminal task is revived", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("projector_revival_limit")
      const tasks = yield* SessionTaskV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const target = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "projector_revival_target"), "projector_revival_target"),
      )
      yield* SessionInput.promoteSteers(db, events, target.task.childSessionID, Number.MAX_SAFE_INTEGER)
      const completed = yield* tasks.settle({
        taskID: target.task.id,
        expectedRevision: target.task.revision,
        status: "completed",
        result: "Initial pass",
      })
      // The projector guards the hard cap rather than the configured policy
      // limit, so fill the root to that cap before attempting the revival.
      yield* Effect.forEach(
        Array.from({ length: SessionTaskV2.MAX_ACTIVE_PER_ROOT }, (_, index) => index),
        (index) =>
          actor(parentSessionID, `projector_revival_blocker_${index}`).pipe(
            Effect.flatMap((value) =>
              tasks.spawn(spawnInput(value, `projector_revival_blocker_${index}`, SessionTaskV2.MAX_ACTIVE_PER_ROOT)),
            ),
          ),
        { concurrency: 1, discard: true },
      )
      const sendActor = yield* actor(parentSessionID, "projector_revival_send", "send_agent")
      const prompt = Prompt.make({ text: "Attempt revival over capacity" })
      const now = DateTime.makeUnsafe(Date.now())
      const pending = SessionTaskV2.Operation.make({
        id: SessionTaskV2.OperationID.create(),
        taskID: completed.id,
        rootSessionID: parentSessionID,
        actor: sendActor,
        kind: "send",
        requestHash: Bun.CryptoHasher.hash("sha256", JSON.stringify(["send", sendActor, completed.id, prompt]), "hex"),
        messageID: SessionMessage.ID.create(),
        prompt,
        status: "pending",
        time: { created: now, updated: now },
      })
      yield* events.publish(SessionEvent.Task.OperationUpdated, {
        sessionID: parentSessionID,
        taskID: completed.id,
        timestamp: now,
        operation: pending,
      })
      const revived = yield* events
        .publish(SessionEvent.Task.Updated, {
          sessionID: parentSessionID,
          taskID: completed.id,
          timestamp: now,
          task: SessionTaskV2.Info.make({
            ...completed,
            status: "running",
            revision: completed.revision + 1,
            result: undefined,
            time: { ...completed.time, updated: now, completed: undefined },
          }),
          operation: SessionTaskV2.Operation.make({
            ...pending,
            status: "applied",
            time: { ...pending.time, updated: now, completed: now },
          }),
        })
        .pipe(Effect.exit)

      expect(revived._tag).toBe("Failure")
      expect(yield* tasks.get(completed.id)).toEqual(completed)
      expect(
        yield* db
          .select()
          .from(SessionTaskOperationTable)
          .where(eq(SessionTaskOperationTable.id, pending.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ status: "pending" })
    }),
  )

  it.effect("resumes a settled task through one retry-safe follow-up", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("send")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "send_spawn"), "send"))
      const { db } = yield* Database.Service
      yield* SessionInput.promoteSteers(
        db,
        yield* EventV2.Service,
        created.task.childSessionID,
        Number.MAX_SAFE_INTEGER,
      )
      const settled = yield* tasks.settle({
        taskID: created.task.id,
        expectedRevision: created.task.revision,
        status: "completed",
        result: "Initial result",
      })
      const input = {
        actor: yield* actor(parentSessionID, "send_followup", "send_agent"),
        taskID: created.task.id,
        prompt: Prompt.make({ text: "Check one more edge" }),
      }

      const sent = yield* tasks.send(input)
      const retried = yield* tasks.send(input)

      expect(settled.status).toBe("completed")
      expect(sent).toMatchObject({ wake: true, task: { status: "running", revision: 3 } })
      expect(retried).toEqual({ ...sent, wake: false })
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, sent.operation.messageID!))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ session_id: created.task.childSessionID, time_cancelled: null })
    }),
  )

  it.effect("keeps an applied follow-up runnable across a settle race", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("send_settle_race")
      const tasks = yield* SessionTaskV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "send_settle_race_spawn"), "send_settle_race"),
      )
      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      const completed = yield* tasks.settle({
        taskID: created.task.id,
        expectedRevision: created.task.revision,
        status: "completed",
        result: "First pass",
      })
      const sent = yield* tasks.send({
        actor: yield* actor(parentSessionID, "send_settle_race_followup", "send_agent"),
        taskID: created.task.id,
        prompt: Prompt.make({ text: "Inspect the remaining edge" }),
      })

      const raced = yield* tasks.settle({
        taskID: sent.task.id,
        expectedRevision: sent.task.revision,
        status: "completed",
        result: "Stale completion",
      })

      expect(completed).toMatchObject({ status: "completed", revision: 2 })
      expect(sent).toMatchObject({ task: { status: "running", revision: 3 }, operation: { status: "applied" } })
      expect(raced).toMatchObject({ status: "running", revision: 3, result: undefined })
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, sent.operation.messageID!))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: null, time_cancelled: null })

      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      expect(
        yield* tasks.settle({
          taskID: sent.task.id,
          expectedRevision: sent.task.revision,
          status: "completed",
          result: "Follow-up complete",
        }),
      ).toMatchObject({ status: "completed", revision: 4, result: "Follow-up complete" })
    }),
  )

  it.effect("lets a sibling subagent message another subagent under the same parent", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("sibling_send")
      const tasks = yield* SessionTaskV2.Service
      const { db } = yield* Database.Service
      const first = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "sibling_first_spawn"), "sibling_first"),
      )
      const second = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "sibling_second_spawn"), "sibling_second"),
      )
      expect(second.task.id).not.toBe(first.task.id)

      const senderOwnedTask = yield* tasks.owner(first.task.childSessionID)
      expect(senderOwnedTask).toBeDefined()
      const sent = yield* tasks.send({
        actor: yield* actor(first.task.childSessionID, "sibling_first_send", "send_agent"),
        taskID: second.task.id,
        prompt: Prompt.make({ text: "Coordinated finding from your sibling analyst" }),
      })
      expect(sent).toMatchObject({ operation: { status: "applied" } })
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, sent.operation.messageID!))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ session_id: second.task.childSessionID, time_cancelled: null })
    }),
  )

  it.effect("rejects a message to a subagent outside the sibling group", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("sibling_send_other_parent")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "sibling_other_spawn"), "sibling_other"),
      )
      expect(
        yield* tasks
          .send({
            actor: yield* actor(created.task.childSessionID, "sibling_other_send", "send_agent"),
            taskID: created.task.id,
            prompt: Prompt.make({ text: "Self message is not a sibling" }),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ resource: created.task.id })
    }),
  )

  it.effect("resumes a durable pending interrupt exactly once", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("pending_interrupt")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "pending_interrupt_spawn"), "pending_interrupt"),
      )
      const interruptActor = yield* actor(parentSessionID, "pending_interrupt_call", "interrupt_agent")
      const now = DateTime.makeUnsafe(Date.now())
      const operation = SessionTaskV2.Operation.make({
        id: SessionTaskV2.OperationID.create(),
        taskID: created.task.id,
        rootSessionID: created.task.rootSessionID,
        actor: interruptActor,
        kind: "interrupt",
        requestHash: Bun.CryptoHasher.hash(
          "sha256",
          JSON.stringify(["interrupt", interruptActor, created.task.id]),
          "hex",
        ),
        status: "pending",
        time: { created: now, updated: now },
      })
      yield* (yield* EventV2.Service).publish(SessionEvent.Task.OperationUpdated, {
        sessionID: parentSessionID,
        taskID: created.task.id,
        timestamp: now,
        operation,
      })

      const resumed = yield* tasks.interrupt({
        operationID: operation.id,
        actor: interruptActor,
        taskID: created.task.id,
      })
      const retried = yield* tasks.interrupt({
        operationID: operation.id,
        actor: interruptActor,
        taskID: created.task.id,
      })
      const completed = yield* tasks.completeInterrupt(operation.id)
      const completedRetry = yield* tasks.completeInterrupt(operation.id)

      expect(resumed).toMatchObject({
        task: { id: created.task.id, status: "running", revision: 1 },
        operation: { id: operation.id, status: "pending" },
        sessions: [created.task.childSessionID],
      })
      expect(retried).toEqual(resumed)
      expect(completed).toMatchObject({
        task: { id: created.task.id, status: "cancelled", revision: 2 },
        operation: { id: operation.id, status: "applied" },
        sessions: [created.task.childSessionID],
      })
      expect(completedRetry).toEqual(completed)
    }),
  )

  it.effect("commits root cancellation only after every child interruption returns", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("cancel_root")
      const tasks = yield* SessionTaskV2.Service
      const children = yield* Effect.forEach(["first", "second"], (suffix) =>
        actor(parentSessionID, `cancel_root_${suffix}`).pipe(
          Effect.flatMap((value) => tasks.spawn(spawnInput(value, `cancel_root_${suffix}`))),
        ),
      )

      const cancelled = yield* tasks.cancelRootWithInterrupt({
        rootSessionID: parentSessionID,
        interrupt: (sessions) =>
          Effect.gen(function* () {
            expect(new Set(sessions)).toEqual(new Set(children.map((item) => item.task.childSessionID)))
            expect(yield* tasks.list({ rootSessionID: parentSessionID })).toMatchObject([
              { status: "running", revision: 1 },
              { status: "running", revision: 1 },
            ])
          }),
      })

      expect(new Set(cancelled.sessions)).toEqual(new Set(children.map((item) => item.task.childSessionID)))
      expect(yield* tasks.list({ rootSessionID: parentSessionID })).toMatchObject([
        { status: "cancelled", revision: 2 },
        { status: "cancelled", revision: 2 },
      ])
      expect(
        yield* tasks.cancelRootWithInterrupt({
          rootSessionID: parentSessionID,
          interrupt: () => Effect.die(new Error("terminal root cancellation must not call interruption again")),
        }),
      ).toEqual({ sessions: [] })
    }),
  )

  it.effect("blocks new root work while cancellation waits and releases the lease afterward", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("cancel_root_lease")
      const tasks = yield* SessionTaskV2.Service
      const existing = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "cancel_root_lease_existing"), "cancel_root_lease_existing"),
      )
      const concurrent = spawnInput(
        yield* actor(parentSessionID, "cancel_root_lease_concurrent"),
        "cancel_root_lease_concurrent",
      )
      const send = {
        actor: yield* actor(parentSessionID, "cancel_root_lease_send", "send_agent"),
        taskID: existing.task.id,
        prompt: Prompt.make({ text: "Must wait for root cancellation" }),
      }
      const interrupt = {
        actor: yield* actor(parentSessionID, "cancel_root_lease_interrupt", "interrupt_agent"),
        taskID: existing.task.id,
      }
      const { db } = yield* Database.Service
      yield* SessionInput.promoteSteers(
        db,
        yield* EventV2.Service,
        existing.task.childSessionID,
        Number.MAX_SAFE_INTEGER,
      )
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cancellation = yield* tasks
        .cancelRootWithInterrupt({
          rootSessionID: parentSessionID,
          interrupt: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      expect(yield* tasks.spawn(concurrent).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.ConflictError",
        resource: parentSessionID,
        message: "Session task graph cancellation is waiting for execution to stop",
      })
      expect(yield* tasks.send(send).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.ConflictError",
        resource: parentSessionID,
      })
      expect(yield* tasks.interrupt(interrupt).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.ConflictError",
        resource: parentSessionID,
      })
      expect(
        yield* tasks
          .cancelWithInterrupt({
            sessionID: parentSessionID,
            taskID: existing.task.id,
            interrupt: () => Effect.die(new Error("blocked cancellation callback was invoked")),
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "SessionTask.ConflictError",
        resource: parentSessionID,
      })
      expect(yield* tasks.settleRun({ sessionID: existing.task.childSessionID, status: "interrupted" })).toMatchObject({
        task: { status: "interrupted", revision: 2 },
        transitioned: true,
      })

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancellation)
      expect(yield* tasks.get(existing.task.id)).toMatchObject({ status: "cancelled", revision: 3 })
      expect((yield* tasks.spawn(concurrent)).task).toMatchObject({ status: "running", revision: 1 })
    }),
  )

  it.effect("releases a failed root lease without terminalizing children that did not stop", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("cancel_root_timeout")
      const tasks = yield* SessionTaskV2.Service
      const children = yield* Effect.forEach(["settled", "stuck"], (suffix) =>
        actor(parentSessionID, `cancel_root_timeout_${suffix}`).pipe(
          Effect.flatMap((value) => tasks.spawn(spawnInput(value, `cancel_root_timeout_${suffix}`))),
        ),
      )
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* Effect.forEach(
        children,
        (child) => SessionInput.promoteSteers(db, events, child.task.childSessionID, Number.MAX_SAFE_INTEGER),
        { discard: true },
      )
      const started = yield* Deferred.make<void>()
      const cancellation = yield* tasks
        .cancelRootWithInterrupt({
          rootSessionID: parentSessionID,
          interrupt: (sessions) =>
            Effect.forEach(
              sessions,
              (sessionID) =>
                sessionID === children[0]!.task.childSessionID
                  ? tasks.settleRun({ sessionID, status: "interrupted" }).pipe(Effect.asVoid, Effect.orDie)
                  : Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(
                        Effect.never.pipe(
                          Effect.timeoutOrElse({
                            duration: "5 seconds",
                            orElse: () => Effect.fail(new Error("child execution did not settle")),
                          }),
                        ),
                      ),
                    ),
              { concurrency: "unbounded", discard: true },
            ),
        })
        .pipe(Effect.exit, Effect.forkChild)

      yield* Deferred.await(started)
      yield* TestClock.adjust("5 seconds")
      expect(Exit.isFailure(yield* Fiber.join(cancellation))).toBe(true)
      expect(yield* tasks.list({ rootSessionID: parentSessionID })).toMatchObject([
        { status: "interrupted", revision: 2 },
        { status: "running", revision: 1 },
      ])

      const retried = yield* tasks.cancelRootWithInterrupt({
        rootSessionID: parentSessionID,
        interrupt: (sessions) =>
          Effect.forEach(
            sessions,
            (sessionID) => tasks.settleRun({ sessionID, status: "interrupted" }).pipe(Effect.asVoid, Effect.orDie),
            { discard: true },
          ),
      })
      expect(retried.sessions).toEqual([children[1]!.task.childSessionID])
      expect(yield* tasks.list({ rootSessionID: parentSessionID })).toMatchObject([
        { status: "cancelled", revision: 3 },
        { status: "cancelled", revision: 3 },
      ])
    }),
  )

  it.effect("retires stale subagent advisories when execution starts", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("board_startup_cleanup")
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const admitted = yield* Effect.forEach(
        ["subagent_board", "user", "subagent_board", "subagent_settle", "subagent_advisory", "shell_job"] as const,
        (source, index) =>
          SessionInput.admit(database.db, events, {
            id: SessionMessage.ID.make(`msg_board_startup_${index}`),
            sessionID: parentSessionID,
            prompt: Prompt.make({ text: `Persisted ${source} input ${index}` }),
            delivery: "queue",
            source,
            kind: "prompt",
          }),
      )
      // The leading board advisory promotes; the queued user input stops the batch, so the
      // advisories behind it stay pending for the boot-time cleanup to retire.
      yield* SessionInput.promoteNextQueued(database.db, events, parentSessionID)
      yield* Effect.gen(function* () {
        yield* SessionExecution.Service
        const statuses = yield* Effect.forEach(admitted, (input) =>
          SessionInput.inputStatus(database.db, { sessionID: parentSessionID, messageID: input.id }),
        )
        expect(statuses.map((input) => input?.status)).toEqual([
          "promoted",
          "admitted",
          "cancelled",
          "cancelled",
          "cancelled",
          "admitted",
        ])
        expect(statuses[2]?.timeCancelled).toBeDefined()
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(SessionExecutionLocal.node, [
            [Database.node, Layer.succeed(Database.Service, database)],
            [EventV2.node, Layer.succeed(EventV2.Service, events)],
            [ProjectV2.node, projects],
            [LocationServiceMap.node, executionLocations],
          ]),
        ),
      )
    }),
  )

  realExecutionIt.live(
    "ignores board admissions while still waking for shell job completion",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("board_admission_wake")
        const tasks = yield* SessionTaskV2.Service
        const created = yield* tasks.spawn(
          spawnInput(yield* actor(parentSessionID, "board_admission_wake"), "board_admission_wake"),
        )
        const started = yield* Deferred.make<SessionSchema.ID>()
        executionRunner.run = ({ sessionID }) => Deferred.succeed(started, sessionID)

        expect(
          yield* tasks.notifyParent({
            taskID: created.task.id,
            text: "A board update was durably admitted.",
            messageID: SessionMessage.ID.make("msg_board_admission_wake"),
            source: "subagent_board",
            coalesce: true,
          }),
        ).toEqual({ sessionID: parentSessionID, admitted: true })
        yield* Effect.sleep("400 millis")
        expect(yield* Deferred.isDone(started)).toBe(false)
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        yield* SessionInput.admit(database.db, events, {
          id: SessionMessage.ID.make("msg_shell_admission_wake"),
          sessionID: parentSessionID,
          prompt: Prompt.make({ text: "Shell job completed." }),
          delivery: "queue",
          source: "shell_job",
          kind: "prompt",
        })
        expect(
          yield* Deferred.await(started).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.fail(new Error("durable shell job admission did not wake the parent")),
            }),
          ),
        ).toBe(parentSessionID)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "re-wakes a drain diverted by advisory busy once the busy window clears",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("advisory_busy_rewake")
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        // A user steer pending while the session is compacting is exactly the input a
        // shell_job-only advisory gate would strand after the window cleared.
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.make("msg_advisory_busy_rewake"),
          sessionID: parentSessionID,
          prompt: Prompt.make({ text: "Are you still there?" }),
          delivery: "steer",
          source: "user",
          kind: "prompt",
        })
        yield* db
          .update(SessionTable)
          .set({ time_compacting: Date.now() })
          .where(eq(SessionTable.id, parentSessionID))
          .run()
          .pipe(Effect.orDie)
        const started = yield* Deferred.make<SessionSchema.ID>()
        executionRunner.run = ({ sessionID }) => Deferred.succeed(started, sessionID)
        const execution = yield* SessionExecution.Service
        yield* execution.wake(parentSessionID)
        yield* Effect.sleep("400 millis")
        expect(yield* Deferred.isDone(started)).toBe(false)
        yield* db
          .update(SessionTable)
          .set({ time_compacting: null })
          .where(eq(SessionTable.id, parentSessionID))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* Deferred.await(started).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.fail(new Error("diverted drain never re-woke after the busy window cleared")),
            }),
          ),
        ).toBe(parentSessionID)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "lets the real execution coordinator finalizer settle under root cancellation without deadlock",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("cancel_root_real_execution")
        const tasks = yield* SessionTaskV2.Service
        const created = yield* tasks.spawn(
          spawnInput(yield* actor(parentSessionID, "cancel_root_real_execution"), "cancel_root_real_execution"),
        )
        const { db } = yield* Database.Service
        yield* SessionInput.promoteSteers(
          db,
          yield* EventV2.Service,
          created.task.childSessionID,
          Number.MAX_SAFE_INTEGER,
        )
        const runnerStarted = yield* Deferred.make<void>()
        const runnerInterrupted = yield* Deferred.make<void>()
        executionRunner.run = ({ sessionID }) =>
          sessionID === created.task.childSessionID
            ? Deferred.succeed(runnerStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(runnerInterrupted, undefined)),
              )
            : Effect.void
        const execution = yield* SessionExecution.Service
        yield* execution.wake(created.task.childSessionID)
        yield* Deferred.await(runnerStarted)

        const cancelled = yield* tasks
          .cancelRootWithInterrupt({
            rootSessionID: parentSessionID,
            interrupt: (sessions) =>
              Effect.gen(function* () {
                expect(sessions).toEqual([created.task.childSessionID])
                yield* Effect.forEach(sessions, execution.interrupt, { discard: true })
              }),
          })
          .pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("root cancellation deadlocked with the execution finalizer")),
            }),
          )

        yield* Deferred.await(runnerInterrupted)
        expect(cancelled.sessions).toEqual([created.task.childSessionID])
        // The child's settle advisory queues a parent input and wakes its drain;
        // join that drain before asserting the coordinator is idle.
        yield* Effect.flatten(execution.claimResume(parentSessionID))
        expect(yield* tasks.get(created.task.id)).toMatchObject({ status: "cancelled", revision: 3 })
        expect(Array.from(yield* execution.active)).toEqual([])
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "locates the terminal task event a drain settles outside the Session location scope",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("settle_run_location")
        const tasks = yield* SessionTaskV2.Service
        const created = yield* tasks.spawn(
          spawnInput(yield* actor(parentSessionID, "settle_run_location"), "settle_run_location"),
        )
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)

        const settled = yield* Deferred.make<EventV2.Payload<typeof SessionEvent.Task.Updated>>()
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== SessionEvent.Task.Updated.type) return Effect.void
          const data = event.data as EventV2.Data<typeof SessionEvent.Task.Updated>
          if (data.taskID !== created.task.id || data.task.status !== "completed") return Effect.void
          return Deferred.succeed(settled, event as EventV2.Payload<typeof SessionEvent.Task.Updated>).pipe(
            Effect.asVoid,
          )
        })

        executionRunner.run = () => Effect.void
        const execution = yield* SessionExecution.Service
        yield* execution.wake(created.task.childSessionID)
        const event = yield* Deferred.await(settled).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(new Error("terminal task event was never published")),
          }),
          Effect.ensuring(unsubscribe),
        )

        // The drain settles the run on the coordinator's global fiber, with no
        // Location.Service in scope. Every per-instance event stream drops frames
        // whose location does not match the serving instance, so a terminal task
        // event without one never reaches a client and the subagent reads as
        // running forever. See the filter in
        // packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
        expect(event.location?.directory).toBe(directory)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "queues one settle advisory for the parent when a child drain completes",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("settle_notify_completed")
        const tasks = yield* SessionTaskV2.Service
        const events = yield* EventV2.Service
        const created = yield* tasks.spawn(
          spawnInput(yield* actor(parentSessionID, "settle_notify_completed"), "settle_notify_completed"),
        )
        const { db } = yield* Database.Service
        yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)

        const admitted = yield* Deferred.make<SessionMessage.ID>()
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== SessionEvent.PromptAdmitted.type) return Effect.void
          const data = event.data as EventV2.Data<typeof SessionEvent.PromptAdmitted>
          if (data.sessionID !== parentSessionID || !data.messageID.startsWith("msg_task_settle_")) return Effect.void
          return Deferred.succeed(admitted, data.messageID).pipe(Effect.asVoid)
        })

        executionRunner.run = () => Effect.void
        const execution = yield* SessionExecution.Service
        yield* execution.wake(created.task.childSessionID)
        yield* Deferred.await(admitted).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(new Error("settle advisory was never admitted to the parent")),
          }),
          Effect.ensuring(unsubscribe),
        )

        const noticed = (yield* SessionInput.pending(db, parentSessionID)).filter((input) =>
          input.id.startsWith("msg_task_settle_"),
        )
        expect(noticed).toHaveLength(1)
        expect(noticed[0]!.delivery).toBe("queue")
        expect(noticed[0]!.source).toBe("subagent_settle")
        expect(noticed[0]!.prompt.text).toContain("reached a terminal state")
        expect(noticed[0]!.prompt.text).toContain(
          `completed: Task settle_notify_completed (task ${created.task.id}, agent explore)`,
        )
        expect(noticed[0]!.prompt.text).toContain("wait_agents")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "carries the error excerpt when a child drain fails",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("settle_notify_failed")
        const tasks = yield* SessionTaskV2.Service
        const events = yield* EventV2.Service
        const created = yield* tasks.spawn(
          spawnInput(yield* actor(parentSessionID, "settle_notify_failed"), "settle_notify_failed"),
        )
        const { db } = yield* Database.Service
        yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)

        const admitted = yield* Deferred.make<SessionMessage.ID>()
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== SessionEvent.PromptAdmitted.type) return Effect.void
          const data = event.data as EventV2.Data<typeof SessionEvent.PromptAdmitted>
          if (data.sessionID !== parentSessionID || !data.messageID.startsWith("msg_task_settle_")) return Effect.void
          return Deferred.succeed(admitted, data.messageID).pipe(Effect.asVoid)
        })

        executionRunner.run = ({ sessionID }) =>
          sessionID === created.task.childSessionID ? Effect.die(new Error("child exploded")) : Effect.void
        const execution = yield* SessionExecution.Service
        yield* execution.wake(created.task.childSessionID)
        yield* Deferred.await(admitted).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(new Error("settle advisory was never admitted to the parent")),
          }),
          Effect.ensuring(unsubscribe),
        )

        const noticed = (yield* SessionInput.pending(db, parentSessionID)).filter((input) =>
          input.id.startsWith("msg_task_settle_"),
        )
        expect(noticed).toHaveLength(1)
        expect(noticed[0]!.prompt.text).toContain(`failed: Task settle_notify_failed (task ${created.task.id}`)
        expect(noticed[0]!.prompt.text).toContain("Error: child exploded")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "does not re-notify when the task terminalized before the drain settled",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("settle_no_second_notify")
        const tasks = yield* SessionTaskV2.Service
        const events = yield* EventV2.Service
        const created = yield* tasks.spawn(
          spawnInput(yield* actor(parentSessionID, "settle_no_second_notify"), "settle_no_second_notify"),
        )
        const { db } = yield* Database.Service
        yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)

        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        executionRunner.run = ({ sessionID }) =>
          sessionID === created.task.childSessionID
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void

        const execution = yield* SessionExecution.Service
        yield* execution.wake(created.task.childSessionID)
        yield* Deferred.await(started).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(new Error("child drain did not start")),
          }),
        )

        // The task terminalizes mid-drain (an interrupt landed); the drain must not
        // emit a second settle advisory for a transition it did not perform.
        expect(yield* tasks.settleRun({ sessionID: created.task.childSessionID, status: "interrupted" })).toMatchObject(
          { transitioned: true },
        )
        yield* Deferred.succeed(release, undefined)
        yield* Effect.flatten(execution.claimResume(created.task.childSessionID))

        expect(yield* tasks.get(created.task.id)).toMatchObject({ status: "interrupted" })
        const noticed = (yield* SessionInput.pending(db, parentSessionID)).filter((input) =>
          input.id.startsWith("msg_task_settle_"),
        )
        expect(noticed).toEqual([])
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  realExecutionIt.live(
    "settles quietly when the drained session owns no task",
    () => {
      const previous = executionRunner.run
      return Effect.gen(function* () {
        const parentSessionID = yield* setup("settle_no_task")
        const { db } = yield* Database.Service
        const ran = yield* Deferred.make<SessionSchema.ID>()
        executionRunner.run = ({ sessionID }) => Deferred.succeed(ran, sessionID)
        const execution = yield* SessionExecution.Service
        yield* execution.wake(parentSessionID)
        expect(
          yield* Deferred.await(ran).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.fail(new Error("session drain did not reach the runner")),
            }),
          ),
        ).toBe(parentSessionID)
        yield* Effect.flatten(execution.claimResume(parentSessionID))
        expect(yield* SessionInput.pending(db, parentSessionID)).toEqual([])
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            executionRunner.run = previous
          }),
        ),
      )
    },
    5_000,
  )

  it.effect("retains actor ownership after an uncoordinated Session deletion", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("actor_tombstone")
      const tasks = yield* SessionTaskV2.Service
      const input = spawnInput(yield* actor(parentSessionID, "actor_tombstone"), "actor_tombstone")
      const created = yield* tasks.spawn(input)
      const { db } = yield* Database.Service

      yield* db.delete(SessionTable).where(eq(SessionTable.id, parentSessionID)).run().pipe(Effect.orDie)

      expect(
        yield* db
          .select()
          .from(SessionTaskActorClaimTable)
          .where(eq(SessionTaskActorClaimTable.operation_id, created.operation.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        task_id: created.task.id,
        actor_session_id: parentSessionID,
        actor_tool_call_id: input.actor.toolCallID,
      })
      expect(yield* tasks.spawn(input).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.ConflictError",
        resource: input.actor.toolCallID,
      })
    }),
  )

  it.effect("persists interrupt intent before committing cancellation after execution settles", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("cancel")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "cancel_spawn"), "cancel"))
      const input = {
        actor: yield* actor(parentSessionID, "cancel_interrupt", "interrupt_agent"),
        taskID: created.task.id,
      }

      const prepared = yield* tasks.interrupt(input)
      const retried = yield* tasks.interrupt(input)
      const cancelled = yield* tasks.completeInterrupt(prepared.operation.id)

      expect(prepared.task).toMatchObject({ status: "running", revision: 1 })
      expect(prepared.operation.status).toBe("pending")
      expect(retried).toEqual(prepared)
      expect(cancelled.task).toMatchObject({ status: "cancelled", revision: 2 })
      expect(cancelled.operation.status).toBe("applied")
      expect(cancelled.sessions).toEqual([created.task.childSessionID])
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ cancelled: SessionInputTable.time_cancelled })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, created.task.childSessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ cancelled: expect.any(Number) }])
      expect(
        yield* tasks.authorizeMutation({ sessionID: created.task.childSessionID }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "SessionTask.OwnedSessionError",
        taskID: created.task.id,
      })
      expect(yield* tasks.authorizeRun(created.task.childSessionID).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.OwnedSessionError",
        taskID: created.task.id,
      })
    }),
  )

  it.effect("keeps ordinary cancellation non-terminal on timeout and commits only after a settled retry", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("cancel_timeout")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "cancel_timeout_spawn"), "cancel_timeout"),
      )
      const started = yield* Deferred.make<void>()
      const cancellationFiber = yield* tasks
        .cancelWithInterrupt({
          sessionID: parentSessionID,
          taskID: created.task.id,
          expectedRevision: created.task.revision,
          interrupt: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(
                Effect.never.pipe(
                  Effect.timeoutOrElse({
                    duration: "5 seconds",
                    orElse: () => Effect.fail(new Error("child execution did not settle")),
                  }),
                ),
              ),
            ),
        })
        .pipe(Effect.exit, Effect.forkChild)

      yield* Deferred.await(started)
      yield* TestClock.adjust("5 seconds")
      const timedOut = yield* Fiber.join(cancellationFiber)
      expect(Exit.isFailure(timedOut)).toBe(true)
      expect(yield* tasks.get(created.task.id)).toMatchObject({ status: "running", revision: 1 })

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, events, created.task.childSessionID, Number.MAX_SAFE_INTEGER)
      expect(yield* tasks.settleRun({ sessionID: created.task.childSessionID, status: "interrupted" })).toMatchObject({
        task: { status: "interrupted", revision: 2 },
        transitioned: true,
      })
      const retried = yield* tasks.cancelWithInterrupt({
        sessionID: parentSessionID,
        taskID: created.task.id,
        expectedRevision: 2,
        interrupt: () => Effect.die(new Error("settled cancellation retry must not interrupt execution again")),
      })

      expect(retried.task).toMatchObject({ status: "cancelled", revision: 3 })
      expect(retried.sessions).toEqual([created.task.childSessionID])
      expect(yield* tasks.get(created.task.id)).toMatchObject({ status: "cancelled", revision: 3 })
    }),
  )

  it.effect("rejects relocation of both task roots and owned children", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("relocation")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "relocation_spawn"), "relocation"))

      expect(yield* tasks.authorizeRelocation(parentSessionID).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.OwnedSessionError",
        sessionID: parentSessionID,
        taskID: created.task.id,
      })
      expect(yield* tasks.authorizeRelocation(created.task.childSessionID).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionTask.OwnedSessionError",
        sessionID: created.task.childSessionID,
        taskID: created.task.id,
      })
      const moved = yield* (yield* EventV2.Service)
        .publish(SessionEvent.Moved, {
          sessionID: created.task.childSessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make("/different-project") }),
          timestamp: DateTime.makeUnsafe(Date.now()),
        })
        .pipe(Effect.exit)
      expect(moved._tag).toBe("Failure")
      expect(yield* (yield* SessionStore.Service).get(created.task.childSessionID)).toMatchObject({
        location: { directory },
      })
    }),
  )

  it.effect("fails stale active work and pending operations during crash reconciliation without replay", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("recovery")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "recovery_spawn"), "recovery"))
      const pendingActor = yield* actor(parentSessionID, "recovery_send", "send_agent")
      const now = DateTime.makeUnsafe(Date.now())
      const pending = SessionTaskV2.Operation.make({
        id: SessionTaskV2.OperationID.create(),
        taskID: created.task.id,
        rootSessionID: created.task.rootSessionID,
        actor: pendingActor,
        kind: "send",
        requestHash: Bun.CryptoHasher.hash(
          "sha256",
          JSON.stringify(["send", pendingActor, created.task.id, Prompt.make({ text: "May have been admitted" })]),
          "hex",
        ),
        messageID: SessionMessage.ID.make("msg_task_pending_recovery"),
        prompt: Prompt.make({ text: "May have been admitted" }),
        status: "pending",
        time: { created: now, updated: now },
      })
      yield* (yield* EventV2.Service).publish(SessionEvent.Task.OperationUpdated, {
        sessionID: parentSessionID,
        taskID: created.task.id,
        timestamp: now,
        operation: pending,
      })
      const { db } = yield* Database.Service
      yield* SessionInput.admit(db, yield* EventV2.Service, {
        id: pending.messageID!,
        sessionID: created.task.childSessionID,
        prompt: pending.prompt!,
        delivery: "steer",
        agent: created.task.agent,
        model: created.task.model,
        kind: "prompt",
      })

      yield* tasks.reconcile()

      expect(yield* tasks.get(created.task.id)).toMatchObject({
        status: "interrupted",
        error: "Subagent execution was interrupted by process recovery and was not replayed.",
      })
      expect(
        yield* db
          .select()
          .from(SessionTaskOperationTable)
          .where(eq(SessionTaskOperationTable.id, pending.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        status: "failed",
        error: "Operation was interrupted by process recovery and was not replayed.",
      })
      expect(
        yield* db
          .select({ cancelled: SessionInputTable.time_cancelled })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, pending.messageID!))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ cancelled: expect.any(Number) })
    }),
  )

  it.effect("recovers a durable spawn intent that crashed before child Session creation", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("recovery_before_child")
      const tasks = yield* SessionTaskV2.Service
      const events = yield* EventV2.Service
      const spawnActor = yield* actor(parentSessionID, "recovery_before_child")
      const input = spawnInput(spawnActor, "recovery_before_child")
      const now = DateTime.makeUnsafe(Date.now())
      const task = SessionTaskV2.Info.make({
        id: SessionTaskV2.ID.create(),
        rootSessionID: parentSessionID,
        parentSessionID,
        childSessionID: SessionSchema.ID.create(),
        actor: spawnActor,
        agent: input.agent,
        model: input.model,
        prompt: input.prompt,
        description: input.description,
        depth: 1,
        status: "starting",
        revision: 0,
        authority: input.authority,
        time: { created: now, updated: now },
      })
      const operation = SessionTaskV2.Operation.make({
        id: SessionTaskV2.OperationID.create(),
        taskID: task.id,
        rootSessionID: parentSessionID,
        actor: spawnActor,
        kind: "spawn",
        requestHash: Bun.CryptoHasher.hash(
          "sha256",
          JSON.stringify([
            "spawn",
            spawnActor,
            input.agent,
            input.model,
            input.prompt,
            input.description,
            input.authority,
          ]),
          "hex",
        ),
        messageID: SessionMessage.ID.create(),
        prompt: input.prompt,
        status: "pending",
        time: { created: now, updated: now },
      })
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: parentSessionID,
        taskID: task.id,
        timestamp: now,
        task,
        operation,
      })

      yield* tasks.reconcile()

      expect(yield* tasks.get(task.id)).toMatchObject({
        status: "interrupted",
        revision: 1,
        error: "Subagent execution was interrupted by process recovery and was not replayed.",
      })
      expect(yield* (yield* SessionStore.Service).get(task.childSessionID)).toBeUndefined()
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionTaskOperationTable)
          .where(eq(SessionTaskOperationTable.id, operation.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ status: "failed" })
      expect(yield* tasks.spawn({ ...input, id: task.id, operationID: operation.id })).toMatchObject({
        task: { id: task.id, status: "interrupted" },
        operation: { id: operation.id, status: "failed" },
        wake: false,
      })
      expect(yield* tasks.list({ rootSessionID: parentSessionID })).toHaveLength(1)
    }),
  )
})

describe("SessionTaskV2 fleets", () => {
  const orchestrating = SessionTaskV2.Authority.make({ ...authority, orchestrate: true })
  const cancel = (tasks: SessionTaskV2.Interface, sessionID: SessionSchema.ID, taskID: SessionTaskV2.ID) =>
    tasks.cancelWithInterrupt({ sessionID, taskID, interrupt: () => Effect.void })

  it.effect("promotes queued spawns in FIFO order as slots free", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("fleet_fifo")
      const tasks = yield* SessionTaskV2.Service
      const spawned = yield* Effect.forEach(
        [0, 1, 2, 3],
        (index) =>
          actor(parentSessionID, `fleet_fifo_${index}`).pipe(
            Effect.flatMap((value) => tasks.spawn(spawnInput(value, `fleet_fifo_${index}`, 2))),
          ),
        { concurrency: 1 },
      )
      expect(spawned.map((item) => item.task.status)).toEqual(["running", "running", "queued", "queued"])
      expect(spawned.map((item) => item.wake)).toEqual([true, true, false, false])
      expect(yield* tasks.promote(parentSessionID, 2)).toEqual([])

      yield* cancel(tasks, parentSessionID, spawned[0]!.task.id)
      expect(yield* tasks.promote(parentSessionID, 2)).toEqual([spawned[2]!.task.childSessionID])
      expect(yield* tasks.get(spawned[2]!.task.id)).toMatchObject({ status: "running" })
      expect(yield* tasks.get(spawned[3]!.task.id)).toMatchObject({ status: "queued" })
      expect(yield* tasks.counts({ parentSessionID })).toEqual({ queued: 1, active: 2, terminal: 1 })
    }),
  )

  it.effect("keeps queued spawns through recovery and cancels them with the root", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("fleet_recovery")
      const tasks = yield* SessionTaskV2.Service
      yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "fleet_recovery_0"), "fleet_recovery_0", 1))
      const queued = yield* tasks.spawn(
        spawnInput(yield* actor(parentSessionID, "fleet_recovery_1"), "fleet_recovery_1", 1),
      )
      yield* tasks.reconcile()
      expect(yield* tasks.get(queued.task.id)).toMatchObject({ status: "queued" })
      const { db } = yield* Database.Service
      const operation = yield* db
        .select()
        .from(SessionTaskOperationTable)
        .where(eq(SessionTaskOperationTable.id, queued.operation.id))
        .get()
        .pipe(Effect.orDie)
      expect(operation?.status).toBe("pending")

      yield* tasks.cancelRootWithInterrupt({ rootSessionID: parentSessionID, interrupt: () => Effect.void })
      expect(yield* tasks.get(queued.task.id)).toMatchObject({ status: "cancelled" })
    }),
  )

  it.effect("lets an orchestrator spawn narrowed workers and cancels them with it", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("fleet_orchestrate")
      const tasks = yield* SessionTaskV2.Service
      const orchestrator = yield* tasks.spawn({
        ...spawnInput(yield* actor(parentSessionID, "fleet_orchestrate"), "fleet_orchestrate", 4),
        authority: orchestrating,
      })
      expect(orchestrator.task.authority.orchestrate).toBe(true)

      const childSessionID = orchestrator.task.childSessionID
      const worker = yield* tasks.spawn({
        ...spawnInput(yield* actor(childSessionID, "fleet_worker"), "fleet_worker", 4),
        wave: "slice",
      })
      expect(worker.task).toMatchObject({ depth: 2, parentTaskID: orchestrator.task.id, wave: "slice" })
      expect(worker.task.authority.ancestorPermissionSets).toEqual([
        authority.parentPermissions,
        authority.hardPermissions,
      ])
      expect(yield* tasks.list({ parentSessionID: childSessionID, wave: "slice" })).toHaveLength(1)
      expect(yield* tasks.list({ parentSessionID: childSessionID, wave: "other" })).toHaveLength(0)

      expect(
        yield* tasks
          .spawn({
            ...spawnInput(yield* actor(childSessionID, "fleet_nested_orchestrate"), "fleet_nested_orchestrate", 4),
            authority: orchestrating,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "SessionTask.OrchestrateError" })
      expect(
        yield* tasks
          .spawn(spawnInput(yield* actor(worker.task.childSessionID, "fleet_depth"), "fleet_depth", 4))
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "SessionTask.DepthLimitError", maximum: 2 })

      yield* cancel(tasks, parentSessionID, orchestrator.task.id)
      expect(yield* tasks.get(worker.task.id)).toMatchObject({ status: "cancelled" })
      expect(yield* tasks.get(orchestrator.task.id)).toMatchObject({ status: "cancelled" })
    }),
  )

  it.effect("holds orchestrators to half the slots and promotes workers past them", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("fleet_quota")
      const tasks = yield* SessionTaskV2.Service
      const orchestrators = yield* Effect.forEach(
        [0, 1, 2],
        (index) =>
          actor(parentSessionID, `fleet_quota_${index}`).pipe(
            Effect.flatMap((value) =>
              tasks.spawn({
                ...spawnInput(value, `fleet_quota_${index}`, 4),
                authority: orchestrating,
              }),
            ),
          ),
        { concurrency: 1 },
      )
      expect(orchestrators.map((item) => item.task.status)).toEqual(["running", "running", "queued"])
      // FIFO admission queues the worker behind the blocked orchestrator...
      const worker = yield* tasks.spawn(spawnInput(yield* actor(parentSessionID, "fleet_quota_w"), "fleet_quota_w", 4))
      expect(worker.task.status).toBe("queued")
      // ...and promotion skips the orchestrator that has no quota left.
      expect(yield* tasks.promote(parentSessionID, 4)).toEqual([worker.task.childSessionID])
      expect(yield* tasks.get(orchestrators[2]!.task.id)).toMatchObject({ status: "queued" })

      const tooSmall = yield* setup("fleet_quota_small")
      expect(
        yield* tasks
          .spawn({
            ...spawnInput(yield* actor(tooSmall, "fleet_quota_small"), "fleet_quota_small", 1),
            authority: orchestrating,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "SessionTask.OrchestrateError" })
    }),
  )

  it.effect("admits one durable operation per batch item and reconciles item retries", () =>
    Effect.gen(function* () {
      const parentSessionID = yield* setup("fleet_batch")
      const tasks = yield* SessionTaskV2.Service
      const base = yield* actor(parentSessionID, "fleet_batch", "spawn_agents")
      const items = yield* Effect.forEach(
        [0, 1, 2],
        (item) =>
          tasks.spawn({
            ...spawnInput(SessionTaskV2.Actor.make({ ...base, item }), `fleet_batch_${item}`, 2),
            wave: "batch",
          }),
        { concurrency: 1 },
      )
      expect(new Set(items.map((item) => item.task.id)).size).toBe(3)
      expect(items.map((item) => item.task.status)).toEqual(["running", "running", "queued"])

      const retried = yield* tasks.spawn({
        ...spawnInput(SessionTaskV2.Actor.make({ ...base, item: 2 }), "fleet_batch_2", 2),
        wave: "batch",
      })
      expect(retried.task.id).toBe(items[2]!.task.id)
      expect(retried.wake).toBe(false)
      expect(yield* tasks.counts({ parentSessionID, wave: "batch" })).toEqual({ queued: 1, active: 2, terminal: 0 })

      // An item only verifies against a recorded spawn_agents call.
      const single = yield* actor(parentSessionID, "fleet_batch_single")
      expect(
        yield* tasks
          .spawn(spawnInput(SessionTaskV2.Actor.make({ ...single, item: 0 }), "fleet_batch_single", 2))
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "SessionTask.ConflictError" })
    }),
  )
})
