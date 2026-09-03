import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionGoal } from "@turenlabs/core/session/goal"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionShell } from "@turenlabs/core/session/shell"
import { SessionGoalTurnTable, SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { testEffect } from "./lib/effect"

const wakeCalls: SessionV2.ID[] = []
const resumeCalls: SessionV2.ID[] = []
const active = new Set<SessionV2.ID>()
const activeProbe = { run: Effect.void as Effect.Effect<void> }
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.gen(function* () {
      const snapshot = new Set(active)
      yield* activeProbe.run
      return snapshot
    }),
    claimResume: (sessionID) => Effect.succeed(Effect.sync(() => resumeCalls.push(sessionID))),
    resume: (sessionID) => Effect.sync(() => resumeCalls.push(sessionID)),
    wake: (sessionID) => Effect.sync(() => wakeCalls.push(sessionID)),
    interrupt: () => Effect.void,
  }),
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
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
      SessionGoal.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
    ],
  ),
)
const directory = AbsolutePath.make("/project")
const model = {
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
  variant: ModelV2.VariantID.make("default"),
}

const setup = Effect.fnUntraced(function* (sessionID: SessionV2.ID) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: sessionID,
      directory,
      title: sessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  wakeCalls.length = 0
  resumeCalls.length = 0
  active.clear()
  activeProbe.run = Effect.void
})

const startAssistant = Effect.fnUntraced(function* (
  sessionID: SessionV2.ID,
  assistantMessageID: SessionMessage.ID,
  tool = false,
) {
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(10),
    agent: "build",
    model,
  })
  if (!tool) return
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID,
    assistantMessageID,
    callID: "call_recovery",
    timestamp: DateTime.makeUnsafe(11),
    name: "read",
  })
  yield* events.publish(SessionEvent.Tool.Input.Ended, {
    sessionID,
    assistantMessageID,
    callID: "call_recovery",
    timestamp: DateTime.makeUnsafe(12),
    text: "{}",
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID,
    assistantMessageID,
    callID: "call_recovery",
    timestamp: DateTime.makeUnsafe(13),
    tool: "read",
    input: {},
    provider: { executed: false },
  })
})

const collect = Effect.fnUntraced(function* () {
  const events = yield* EventV2.Service
  const seen: EventV2.Payload[] = []
  const unsubscribe = yield* events.listen((event) => Effect.sync(() => seen.push(event)))
  yield* Effect.addFinalizer(() => unsubscribe)
  return seen
})

describe("SessionV2 crash recovery", () => {
  it.effect("clears a compacting marker left by a crashed manual compaction", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_manual_compaction")
      yield* setup(sessionID)
      yield* (yield* EventV2.Service).publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_recovery_manual_compaction"),
        timestamp: DateTime.makeUnsafe(10),
        reason: "manual",
      })

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toEqual({ status: "idle" })
      expect(
        yield* (yield* Database.Service).db
          .select({ value: SessionTable.time_compacting })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ value: null })
    }),
  )

  it.effect(
    "locates every settlement event recovery publishes from its global fiber",
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_location")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_location")
      yield* setup(sessionID)
      yield* (yield* SessionGoal.Service).create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_location"),
        objective: SessionGoal.Objective.make("Reach the client that is watching this directory"),
      })
      yield* startAssistant(sessionID, assistantMessageID, true)
      const seen = yield* collect()

      yield* (yield* SessionV2.Service).recover(sessionID)

      // Recovery runs on a global-node fiber with no Location.Service, so every
      // frame it publishes carries no location unless the placement is passed
      // explicitly. Per-instance event streams drop unlocated frames, so a
      // recovery outcome without one never reaches a live client and the UI
      // keeps rendering an interrupted turn as running until it refetches. See
      // the filter in
      // packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
      const expected = new Set<string>([
        SessionEvent.Tool.Failed.type,
        SessionEvent.Step.Failed.type,
        SessionEvent.Goal.Updated.type,
      ])
      const settlement = seen.filter((event) => expected.has(event.type))
      expect(settlement.map((event) => event.type).sort()).toEqual(
        [SessionEvent.Goal.Updated.type, SessionEvent.Step.Failed.type, SessionEvent.Tool.Failed.type].sort(),
      )
      for (const event of settlement) expect([event.type, event.location?.directory]).toEqual([event.type, directory])
    }),
  )

  it.effect(
    "locates the shell settlement recovery publishes from its global fiber",
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_shell_location")
      const shellMessageID = SessionMessage.ID.make("msg_recovery_shell_location")
      yield* setup(sessionID)
      yield* (yield* EventV2.Service).publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: shellMessageID,
        callID: "call_recovery_shell_location",
        command: "printf must-not-replay",
        timeout: 1_000,
        timestamp: DateTime.makeUnsafe(10),
      })
      const seen = yield* collect()

      yield* (yield* SessionV2.Service).recover(sessionID)

      const ended = seen.filter((event) => event.type === SessionEvent.Shell.Ended.type)
      expect(ended).toHaveLength(1)
      expect(ended[0]!.location?.directory).toBe(directory)
    }),
  )

  it.effect("settles an incomplete turn, pauses its active goal, and reports an idle recovery boundary", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_incomplete")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_incomplete")
      yield* setup(sessionID)
      yield* (yield* SessionGoal.Service).create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_incomplete"),
        objective: SessionGoal.Objective.make("Recover without replaying provider work"),
      })
      yield* startAssistant(sessionID, assistantMessageID, true)
      const session = yield* SessionV2.Service

      const recovered = yield* session.recover(sessionID)
      const repeated = yield* session.recover(sessionID)
      const paused = yield* session.goal.get(sessionID)

      expect(recovered).toMatchObject({
        status: "interrupted",
        assistantMessageID,
        reason: "Provider turn was interrupted by process restart and was not replayed.",
        next: "idle",
      })
      expect(repeated).toEqual({ status: "idle" })
      expect(paused).toMatchObject({ revision: 2, status: "paused", tokensUsed: 0 })
      expect(wakeCalls).toEqual([])
      const message = yield* session.message({ sessionID, messageID: assistantMessageID })
      expect(message).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: recovered.status === "interrupted" ? recovered.reason : "" },
        content: [
          {
            type: "tool",
            id: "call_recovery",
            state: {
              status: "error",
              error: {
                type: "unknown",
                message: recovered.status === "interrupted" ? recovered.reason : "",
              },
            },
          },
        ],
      })
      const { db } = yield* Database.Service
      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Step.Failed.type, 2)))
          .all()
          .pipe(Effect.orDie)).filter((event) => event.aggregate_id === sessionID),
      ).toHaveLength(1)

      const resumed = yield* session.goal.status({
        sessionID,
        goalID: paused!.id,
        expectedRevision: paused!.revision,
        status: "active",
      })
      expect(resumed).toMatchObject({ revision: 3, status: "active" })
      expect(wakeCalls).toEqual([sessionID])
      expect(resumeCalls).toEqual([])
    }),
  )

  it.effect("recovers a crash before the accounting commit without inventing provider usage", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_before_goal_account")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_before_goal_account")
      yield* setup(sessionID)
      yield* (yield* SessionGoal.Service).create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_before_goal_account"),
        objective: SessionGoal.Objective.make("Do not fabricate usage after a pre-commit crash"),
      })
      yield* startAssistant(sessionID, assistantMessageID)

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toMatchObject({
        status: "interrupted",
        assistantMessageID,
      })
      expect(yield* (yield* SessionGoal.Service).get(sessionID)).toMatchObject({
        revision: 2,
        status: "paused",
        tokensUsed: 0,
      })
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionGoalTurnTable)
          .where(eq(SessionGoalTurnTable.assistant_message_id, assistantMessageID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("preserves a committed turn ledger across crash recovery exactly once", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_after_goal_account")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_after_goal_account")
      yield* setup(sessionID)
      const goals = yield* SessionGoal.Service
      const activeGoal = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_after_goal_account"),
        objective: SessionGoal.Objective.make("Preserve committed usage without replaying provider work"),
      })
      yield* startAssistant(sessionID, assistantMessageID)
      const input = {
        sessionID,
        goalID: activeGoal.id,
        expectedRevision: activeGoal.revision,
        checkpointID: assistantMessageID,
        tokenDelta: 5,
        activeTimeMsDelta: 2_000,
        mode: "ActiveOrStopped" as const,
      }
      expect(yield* goals.account(input)).toMatchObject({
        revision: 2,
        status: "active",
        tokensUsed: 5,
        timeUsedSeconds: 2,
      })

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toMatchObject({
        status: "interrupted",
        assistantMessageID,
      })
      expect(yield* goals.account(input)).toMatchObject({
        revision: 3,
        status: "paused",
        tokensUsed: 5,
        timeUsedSeconds: 2,
      })
      const resumed = yield* goals.status({
        sessionID,
        goalID: activeGoal.id,
        expectedRevision: SessionGoal.Revision.make(3),
        status: "active",
      })
      expect(resumed).toMatchObject({
        revision: 4,
        status: "active",
        tokensUsed: 5,
        timeUsedSeconds: 2,
      })
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionGoalTurnTable)
          .where(eq(SessionGoalTurnTable.assistant_message_id, assistantMessageID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("schedules an active goal only after its prior step durably ended", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_completed")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_completed")
      yield* setup(sessionID)
      yield* (yield* SessionGoal.Service).create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_completed"),
        objective: SessionGoal.Objective.make("Continue only from a durable boundary"),
      })
      yield* startAssistant(sessionID, assistantMessageID)
      yield* (yield* EventV2.Service).publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(20),
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toEqual({ status: "scheduled" })
      expect(wakeCalls).toEqual([sessionID])
      expect(yield* (yield* SessionGoal.Service).get(sessionID)).toMatchObject({
        revision: 1,
        status: "active",
      })
    }),
  )

  it.effect("does not wake an active goal from a terminally failed session", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_failed_goal")
      yield* setup(sessionID)
      const goals = yield* SessionGoal.Service
      const goal = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_failed_goal"),
        objective: SessionGoal.Objective.make("Wait for an explicit provider recovery"),
      })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ status: "failed" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toEqual({ status: "idle" })
      expect(wakeCalls).toEqual([])
      expect(yield* goals.get(sessionID)).toMatchObject({ id: goal.id, revision: 2, status: "paused" })

      const resumed = yield* (yield* SessionV2.Service).goal.status({
        sessionID,
        goalID: goal.id,
        expectedRevision: SessionGoal.Revision.make(2),
        status: "active",
      })
      expect(resumed).toMatchObject({ id: goal.id, revision: 3, status: "active" })
      expect(wakeCalls).toEqual([sessionID])
      expect(
        yield* db
          .select({ status: SessionTable.status })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "idle" })
    }),
  )

  it.effect("does not replay an active goal after a stale retry row", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_retry_goal")
      yield* setup(sessionID)
      const goals = yield* SessionGoal.Service
      const goal = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_retry_goal"),
        objective: SessionGoal.Objective.make("Wait for an explicit retry recovery"),
      })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ status: "retry" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toEqual({ status: "idle" })
      expect(wakeCalls).toEqual([])
      expect(yield* goals.get(sessionID)).toMatchObject({ id: goal.id, revision: 2, status: "paused" })
    }),
  )

  it.effect("does not mistake a process-owned incomplete turn for a crash", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_running")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_running")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID)
      active.add(sessionID)

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toEqual({ status: "running" })
      expect(wakeCalls).toEqual([])
      const message = yield* (yield* SessionV2.Service).message({ sessionID, messageID: assistantMessageID })
      expect(message).toMatchObject({ type: "assistant" })
      expect(message?.type === "assistant" ? message.time.completed : "not-assistant").toBeUndefined()
    }).pipe(Effect.ensuring(Effect.sync(() => active.clear()))),
  )

  it.effect("settles an incomplete tail even when no active goal remains", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_no_goal")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_no_goal")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID)

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toMatchObject({
        status: "interrupted",
        assistantMessageID,
      })
      expect(wakeCalls).toEqual([])
      expect(yield* (yield* SessionV2.Service).message({ sessionID, messageID: assistantMessageID })).toMatchObject({
        type: "assistant",
        finish: "error",
        time: { completed: expect.anything() },
      })
    }),
  )

  it.effect("settles a stale running shell without replaying the command", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_shell")
      const shellMessageID = SessionMessage.ID.make("msg_recovery_shell")
      const callID = "call_recovery_shell"
      yield* setup(sessionID)
      yield* (yield* EventV2.Service).publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: shellMessageID,
        callID,
        command: "printf must-not-replay",
        timeout: 1_000,
        timestamp: DateTime.makeUnsafe(10),
      })
      const session = yield* SessionV2.Service
      const reason = SessionShell.INTERRUPTED_ERROR

      expect(yield* session.recover(sessionID)).toEqual({
        status: "interrupted",
        shellMessageID,
        reason,
        next: "idle",
      })
      expect(yield* session.recover(sessionID)).toEqual({ status: "idle" })
      expect(yield* session.message({ sessionID, messageID: shellMessageID })).toMatchObject({
        id: shellMessageID,
        type: "shell",
        callID,
        command: "printf must-not-replay",
        status: "failed",
        output: reason,
        error: reason,
        time: { completed: expect.anything() },
      })
      const { db } = yield* Database.Service
      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Shell.Ended.type, 1)))
          .all()
          .pipe(Effect.orDie)).filter((event) => event.aggregate_id === sessionID),
      ).toHaveLength(1)
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("settles an incomplete tail without reviving a goal that already completed", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_complete_goal")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_complete_goal")
      yield* setup(sessionID)
      const goals = yield* SessionGoal.Service
      const activeGoal = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_complete_goal"),
        objective: SessionGoal.Objective.make("Keep the committed terminal goal"),
      })
      yield* startAssistant(sessionID, assistantMessageID, true)
      const complete = yield* goals.status({
        sessionID,
        goalID: activeGoal.id,
        expectedRevision: activeGoal.revision,
        status: "complete",
      })

      expect(yield* (yield* SessionV2.Service).recover(sessionID)).toMatchObject({
        status: "interrupted",
        assistantMessageID,
      })
      expect(yield* goals.get(sessionID)).toMatchObject({
        id: complete.id,
        revision: complete.revision,
        status: "complete",
      })
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("schedules a safe pending inbox even without an active goal", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_pending")
      yield* setup(sessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: { text: "Recover this admitted prompt" },
        resume: false,
      })

      expect(yield* session.recover(sessionID)).toEqual({ status: "scheduled" })
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("settles an incomplete assistant before scheduling an already-admitted steer", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_assistant_steer")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_assistant_steer")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID, true)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_recovery_pending_steer"),
        sessionID,
        prompt: { text: "Continue from the durable boundary" },
        delivery: "steer",
        resume: false,
      })

      expect(yield* session.recover(sessionID)).toEqual({
        status: "interrupted",
        assistantMessageID,
        reason: "Provider turn was interrupted by process restart and was not replayed.",
        next: "scheduled",
      })
      expect(wakeCalls).toEqual([sessionID])
      expect(yield* session.recover(sessionID)).toEqual({ status: "scheduled" })
      const { db } = yield* Database.Service
      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Step.Failed.type, 2)))
          .all()
          .pipe(Effect.orDie)).filter((event) => event.aggregate_id === sessionID),
      ).toHaveLength(1)
    }),
  )

  it.effect("settles an incomplete assistant before scheduling an already-admitted queue item", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_assistant_queue")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_assistant_queue")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_recovery_pending_queue"),
        sessionID,
        prompt: { text: "Run only after the interrupted turn is settled" },
        delivery: "queue",
        resume: false,
      })

      expect(yield* session.recover(sessionID)).toEqual({
        status: "interrupted",
        assistantMessageID,
        reason: "Provider turn was interrupted by process restart and was not replayed.",
        next: "scheduled",
      })
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("settles an incomplete shell before scheduling an already-admitted prompt", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_shell_prompt")
      const shellMessageID = SessionMessage.ID.make("msg_recovery_shell_prompt")
      yield* setup(sessionID)
      yield* (yield* EventV2.Service).publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: shellMessageID,
        callID: "call_recovery_shell_prompt",
        command: "printf must-not-replay",
        timeout: 1_000,
        timestamp: DateTime.makeUnsafe(10),
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_recovery_after_shell"),
        sessionID,
        prompt: { text: "Continue after shell recovery" },
        resume: false,
      })

      expect(yield* session.recover(sessionID)).toEqual({
        status: "interrupted",
        shellMessageID,
        reason: SessionShell.INTERRUPTED_ERROR,
        next: "scheduled",
      })
      expect(wakeCalls).toEqual([sessionID])
      expect(yield* session.message({ sessionID, messageID: shellMessageID })).toMatchObject({
        type: "shell",
        status: "failed",
        error: SessionShell.INTERRUPTED_ERROR,
      })
    }),
  )

  it.effect("projects recovery settlement on the writer before returning", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_writer")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_writer")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID)
      const session = yield* SessionV2.Service

      yield* session.recover(sessionID)

      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ data: { time: { completed: 0 }, finish: "error" } })
    }),
  )

  it.effect("serializes a wake registration against crash settlement", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_wake_race")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_wake_race")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      activeProbe.run = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const session = yield* SessionV2.Service

      const recovering = yield* session.recover(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const waking = yield* session.wake(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(wakeCalls).toEqual([])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(recovering)).toMatchObject({
        status: "interrupted",
        assistantMessageID,
        next: "idle",
      })
      yield* Fiber.join(waking)
      expect(wakeCalls).toEqual([sessionID])
      expect(yield* session.message({ sessionID, messageID: assistantMessageID })).toMatchObject({
        type: "assistant",
        finish: "error",
      })
    }).pipe(Effect.ensuring(Effect.sync(() => (activeProbe.run = Effect.void)))),
  )

  it.effect("settles before recovery and a concurrent wake schedule the same pending inbox", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_pending_wake_race")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_pending_wake_race")
      yield* setup(sessionID)
      yield* startAssistant(sessionID, assistantMessageID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_recovery_pending_wake_input"),
        sessionID,
        prompt: { text: "Schedule only after settlement" },
        resume: false,
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      activeProbe.run = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))

      const recovering = yield* session.recover(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const waking = yield* session.wake(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(wakeCalls).toEqual([])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(recovering)).toMatchObject({
        status: "interrupted",
        assistantMessageID,
        next: "scheduled",
      })
      yield* Fiber.join(waking)
      expect(wakeCalls).toEqual([sessionID, sessionID])
      expect(yield* session.message({ sessionID, messageID: assistantMessageID })).toMatchObject({
        type: "assistant",
        finish: "error",
      })
    }).pipe(Effect.ensuring(Effect.sync(() => (activeProbe.run = Effect.void)))),
  )

  it.effect("serializes goal resume behind recovery settlement", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_goal_resume_race")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_goal_resume_race")
      yield* setup(sessionID)
      const goals = yield* SessionGoal.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_goal_resume_race"),
        objective: SessionGoal.Objective.make("Resume only after recovery settles"),
      })
      const paused = yield* goals.status({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        status: "paused",
      })
      yield* startAssistant(sessionID, assistantMessageID)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      activeProbe.run = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const session = yield* SessionV2.Service

      const recovering = yield* session.recover(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const resuming = yield* session.goal
        .status({
          sessionID,
          goalID: paused.id,
          expectedRevision: paused.revision,
          status: "active",
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(wakeCalls).toEqual([])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(recovering)).toMatchObject({ status: "interrupted" })
      expect(yield* Fiber.join(resuming)).toMatchObject({ revision: 3, status: "active" })
      expect(wakeCalls).toEqual([sessionID])
    }).pipe(Effect.ensuring(Effect.sync(() => (activeProbe.run = Effect.void)))),
  )

  it.effect("reconciles an idempotent pause serialized behind recovery", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_goal_pause_race")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_goal_pause_race")
      yield* setup(sessionID)
      const created = yield* (yield* SessionGoal.Service).create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_goal_pause_race"),
        objective: SessionGoal.Objective.make("Pause exactly once during recovery"),
      })
      yield* startAssistant(sessionID, assistantMessageID)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      activeProbe.run = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const session = yield* SessionV2.Service

      const recovering = yield* session.recover(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const pausing = yield* session.goal
        .status({
          sessionID,
          goalID: created.id,
          expectedRevision: created.revision,
          status: "paused",
        })
        .pipe(Effect.forkChild)
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(recovering)).toMatchObject({ status: "interrupted" })
      expect(yield* Fiber.join(pausing)).toMatchObject({ revision: 2, status: "paused" })
      expect(yield* session.goal.get(sessionID)).toMatchObject({ revision: 2, status: "paused" })
    }).pipe(Effect.ensuring(Effect.sync(() => (activeProbe.run = Effect.void)))),
  )

  it.effect("returns a typed clear conflict when recovery wins the revision race", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_recovery_goal_clear_race")
      const assistantMessageID = SessionMessage.ID.make("msg_recovery_goal_clear_race")
      yield* setup(sessionID)
      const created = yield* (yield* SessionGoal.Service).create({
        sessionID,
        id: SessionGoal.ID.make("goal_recovery_goal_clear_race"),
        objective: SessionGoal.Objective.make("Do not clear a recovery-updated revision"),
      })
      yield* startAssistant(sessionID, assistantMessageID)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      activeProbe.run = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const session = yield* SessionV2.Service

      const recovering = yield* session.recover(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const clearing = yield* session.goal
        .clear({
          sessionID,
          goalID: created.id,
          expectedRevision: created.revision,
        })
        .pipe(Effect.forkChild)
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(recovering)).toMatchObject({ status: "interrupted" })
      const cleared = yield* Fiber.await(clearing)
      expect(Exit.isFailure(cleared)).toBeTrue()
      expect(Exit.isFailure(cleared) ? String(cleared.cause) : "").toContain("SessionGoal.ConflictError")
      expect(yield* session.goal.get(sessionID)).toMatchObject({ revision: 2, status: "paused" })
    }).pipe(Effect.ensuring(Effect.sync(() => (activeProbe.run = Effect.void)))),
  )
})
