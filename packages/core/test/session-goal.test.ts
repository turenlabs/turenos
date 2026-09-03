import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Exit, Layer, Ref } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionGoal } from "@turenlabs/core/session/goal"
import { SessionMessage } from "@turenlabs/core/session/message"
import {
  SessionGoalIdentityTable,
  SessionGoalTable,
  SessionGoalTurnTable,
  SessionInputTable,
  SessionMessageIdentityTable,
  SessionTable,
} from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const wakeCalls: SessionV2.ID[] = []
const interruptCalls: Array<{ readonly sessionID: SessionV2.ID; readonly status: string | undefined }> = []
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      claimResume: () => Effect.succeed(Effect.void),
      resume: () => Effect.void,
      wake: (sessionID) => Effect.sync(() => wakeCalls.push(sessionID)),
      interrupt: (sessionID) =>
        Effect.gen(function* () {
          const row = yield* db
            .select({ status: SessionGoalTable.status })
            .from(SessionGoalTable)
            .where(eq(SessionGoalTable.session_id, sessionID))
            .get()
            .pipe(Effect.orDie)
          interruptCalls.push({ sessionID, status: row?.status })
        }),
    })
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionStore.node, SessionGoal.node, SessionV2.node]),
    [[SessionExecution.node, execution]],
  ),
)
const sessionID = SessionV2.ID.make("ses_goal_test")
const location = AbsolutePath.make("/project")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: location, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "goal",
      directory: location,
      title: "goal",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionGoal", () => {
  it.effect("atomically creates a goal with its first admitted objective and reconciles exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const goalID = SessionGoal.ID.make("goal_exact")
      const messageID = SessionMessage.ID.make("msg_goal_exact")
      const agent = AgentV2.ID.make("goal-agent")
      const model = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("goal-provider"),
        id: ModelV2.ID.make("goal-model"),
        variant: ModelV2.VariantID.make("high"),
      })
      const input = {
        sessionID,
        id: goalID,
        messageID,
        objective: SessionGoal.Objective.make("Finish the durable goal slice"),
        agent,
        model,
      }
      wakeCalls.length = 0

      const [first, retried] = yield* Effect.all([session.goal.set(input), session.goal.set(input)], {
        concurrency: "unbounded",
      })
      const admitted = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, messageID))
        .all()
        .pipe(Effect.orDie)
      const events = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Goal.Updated.type, 1)))
        .all()
        .pipe(Effect.orDie)

      expect(retried).toEqual(first)
      expect(first).toMatchObject({ id: goalID, revision: 1, status: "active" })
      expect(admitted).toHaveLength(1)
      expect(admitted[0]).toMatchObject({
        id: messageID,
        session_id: sessionID,
        admitted_seq: events[0]?.seq,
        prompt: { text: input.objective },
        delivery: "steer",
        agent,
        model,
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toMatchObject({ admission: { messageID, agent, model } })
      expect(wakeCalls).toEqual([sessionID, sessionID])

      const replacementAgent = AgentV2.ID.make("replacement-agent")
      const replacementModel = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("replacement-provider"),
        id: ModelV2.ID.make("replacement-model"),
      })
      yield* session.switchAgent({ sessionID, agent: replacementAgent })
      yield* session.switchModel({ sessionID, model: replacementModel })
      expect(yield* session.goal.set(input)).toEqual(first)
      expect(yield* session.get(sessionID)).toMatchObject({ agent: replacementAgent, model: replacementModel })
      expect(
        yield* session.goal.set({ ...input, agent: replacementAgent, model: replacementModel }).pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
    }),
  )

  it.effect("reconciles concurrent exact retries by stable message ID when the goal ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.make("msg_goal_message_retry")
      const input = {
        sessionID,
        messageID,
        objective: SessionGoal.Objective.make("Recover the create response by message identity"),
      }

      const [first, retried] = yield* Effect.all([goals.create(input), goals.create(input)], {
        concurrency: "unbounded",
      })

      expect(retried).toEqual(first)
      expect(first).toMatchObject({ revision: 1, objective: input.objective })
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, messageID)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("reconciles a migrated reverted goal admission without waking or emitting another event", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = {
        sessionID,
        id: SessionGoal.ID.make("goal_migrated_reverted"),
        messageID: SessionMessage.ID.make("msg_goal_migrated_reverted"),
        objective: SessionGoal.Objective.make("Recover this migrated goal response"),
      }
      const created = yield* session.goal.set(input)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, input.messageID)).run().pipe(Effect.orDie)
      yield* db
        .update(SessionMessageIdentityTable)
        .set({ state: "reverted" })
        .where(eq(SessionMessageIdentityTable.id, input.messageID))
        .run()
        .pipe(Effect.orDie)
      const beforeEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Goal.Updated.type, 1)))
        .all()
        .pipe(Effect.orDie)
      wakeCalls.length = 0

      expect(yield* session.goal.set(input)).toEqual(created)
      expect(wakeCalls).toEqual([])
      expect(
        yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Goal.Updated.type, 1)))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(beforeEvents.length)
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, input.messageID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* session.goal
          .set({
            ...input,
            objective: SessionGoal.Objective.make("Changed migrated goal"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
    }),
  )

  it.effect("returns typed conflicts for global goal and message identity collisions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const firstSessionID = SessionV2.ID.make("ses_goal_global_first")
      const secondSessionID = SessionV2.ID.make("ses_goal_global_second")
      yield* db
        .insert(SessionTable)
        .values(
          [firstSessionID, secondSessionID].map((id) => ({
            id,
            project_id: Project.ID.global,
            slug: id,
            directory: location,
            title: id,
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const goalID = SessionGoal.ID.make("goal_global_collision")
      const messageID = SessionMessage.ID.make("msg_goal_global_collision")
      const attempts = yield* Effect.all(
        [
          session.goal
            .set({
              sessionID: firstSessionID,
              id: goalID,
              messageID,
              objective: SessionGoal.Objective.make("First global owner"),
            })
            .pipe(Effect.exit),
          session.goal
            .set({
              sessionID: secondSessionID,
              id: goalID,
              messageID,
              objective: SessionGoal.Objective.make("Second global owner"),
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
      expect(attempts.filter(Exit.isFailure)).toHaveLength(1)
      const loser = Exit.isSuccess(attempts[0]) ? secondSessionID : firstSessionID
      const failure = attempts.find(Exit.isFailure)
      expect(failure ? String(failure.cause) : "").toContain("SessionGoal.ConflictError")

      expect(
        yield* session.goal
          .set({
            sessionID: loser,
            id: SessionGoal.ID.make("goal_global_message_collision"),
            messageID,
            objective: SessionGoal.Objective.make("Cannot reuse the winner message"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
      expect(yield* session.goal.get(loser)).toBeUndefined()
    }),
  )

  it.effect("does not resurrect a cleared goal from its retained admitted input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = {
        sessionID,
        id: SessionGoal.ID.make("goal_cleared_retry"),
        messageID: SessionMessage.ID.make("msg_goal_cleared_retry"),
        objective: SessionGoal.Objective.make("Stay cleared after an exact retry"),
      }
      const created = yield* session.goal.set(input)
      const paused = yield* session.goal.status({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        status: "paused",
      })
      yield* session.goal.clear({
        sessionID,
        goalID: paused.id,
        expectedRevision: paused.revision,
      })

      expect(yield* session.goal.set(input).pipe(Effect.flip)).toBeInstanceOf(SessionGoal.ConflictError)
      expect(
        yield* session.goal
          .set({
            ...input,
            messageID: SessionMessage.ID.make("msg_goal_cleared_reuse"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)

      const replacement = yield* session.goal.set({
        sessionID,
        id: SessionGoal.ID.make("goal_after_clear"),
        messageID: SessionMessage.ID.make("msg_goal_after_clear"),
        objective: SessionGoal.Objective.make("Continue with a distinct goal identity"),
      })
      expect(
        yield* session.goal
          .edit({
            sessionID,
            goalID: created.id,
            expectedRevision: paused.revision,
            objective: SessionGoal.Objective.make("A stale edit must not touch the replacement"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
      expect(
        yield* session.goal
          .status({
            sessionID,
            goalID: created.id,
            expectedRevision: paused.revision,
            status: "complete",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
      expect(yield* session.goal.get(sessionID)).toEqual(replacement)
      expect(
        yield* db
          .select({
            goalID: SessionGoalIdentityTable.goal_id,
            state: SessionGoalIdentityTable.state,
            finalRevision: SessionGoalIdentityTable.final_revision,
          })
          .from(SessionGoalIdentityTable)
          .all()
          .pipe(Effect.orDie),
      ).toEqual(
        expect.arrayContaining([
          { goalID: created.id, state: "cleared", finalRevision: paused.revision },
          { goalID: replacement.id, state: "current", finalRevision: null },
        ]),
      )
    }),
  )

  it.effect("keeps tool-created goals goal-only when messageID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const { db } = yield* Database.Service

      const goal = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_tool"),
        objective: SessionGoal.Objective.make("Track the current user turn"),
      })

      expect(goal.status).toBe("active")
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects unfinished replacement and permits replacement after completion", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const first = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_first"),
        objective: SessionGoal.Objective.make("First goal"),
      })
      const unfinished = yield* goals
        .create({
          sessionID,
          id: SessionGoal.ID.make("goal_second"),
          objective: SessionGoal.Objective.make("Second goal"),
        })
        .pipe(Effect.flip)
      expect(unfinished._tag).toBe("SessionGoal.ConflictError")

      const completed = yield* goals.status({
        sessionID,
        goalID: first.id,
        expectedRevision: first.revision,
        status: "complete",
      })
      const replacement = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_second"),
        objective: SessionGoal.Objective.make("Second goal"),
      })

      expect(completed.status).toBe("complete")
      expect(replacement).toMatchObject({ id: "goal_second", revision: 1, status: "active" })
    }),
  )

  it.effect("enforces revision CAS while editing an objective", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_edit_cas"),
        objective: SessionGoal.Objective.make("Original objective"),
      })
      const edited = yield* goals.edit({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        objective: SessionGoal.Objective.make("Updated objective"),
      })
      const stale = yield* goals
        .edit({
          sessionID,
          goalID: created.id,
          expectedRevision: created.revision,
          objective: SessionGoal.Objective.make("Stale edit"),
        })
        .pipe(Effect.flip)

      expect(edited).toMatchObject({ revision: 2, objective: "Updated objective", tokensUsed: 0 })
      expect(stale).toMatchObject({ _tag: "SessionGoal.ConflictError", actualGoalID: created.id, actualRevision: 2 })
    }),
  )

  it.effect("preserves accounting when editing an active objective", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_edit_accounted"),
        objective: SessionGoal.Objective.make("Preserve work before an edit"),
      })
      const accounted = yield* goals.account({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        tokenDelta: 20,
        activeTimeMsDelta: 0,
      })
      wakeCalls.length = 0

      const edited = yield* session.goal.edit({
        sessionID,
        goalID: accounted.id,
        expectedRevision: accounted.revision,
        objective: SessionGoal.Objective.make("Preserve work after an edit"),
      })

      expect(edited).toMatchObject({
        revision: 3,
        objective: "Preserve work after an edit",
        status: "active",
        tokensUsed: 20,
      })
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("wakes after an active edit but keeps paused edits idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const created = yield* session.goal.set({
        sessionID,
        id: SessionGoal.ID.make("goal_edit_wake"),
        messageID: SessionMessage.ID.make("msg_goal_edit_wake"),
        objective: SessionGoal.Objective.make("Initial objective"),
      })
      wakeCalls.length = 0
      const edited = yield* session.goal.edit({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        objective: SessionGoal.Objective.make("Updated active objective"),
      })
      expect(wakeCalls).toEqual([sessionID])

      const paused = yield* session.goal.status({
        sessionID,
        goalID: edited.id,
        expectedRevision: edited.revision,
        status: "paused",
      })
      wakeCalls.length = 0
      yield* session.goal.edit({
        sessionID,
        goalID: paused.id,
        expectedRevision: paused.revision,
        objective: SessionGoal.Objective.make("Updated paused objective"),
      })
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("accounts precise loop usage and rejects stale goal accounting", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_account"),
        objective: SessionGoal.Objective.make("Track provider usage"),
      })
      const first = yield* goals.account({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        tokenDelta: 3,
        activeTimeMsDelta: 1_500,
      })
      const second = yield* goals.account({
        sessionID,
        goalID: created.id,
        expectedRevision: first.revision,
        tokenDelta: 2,
        activeTimeMsDelta: 600,
      })
      const completed = yield* goals.status({
        sessionID,
        goalID: second.id,
        expectedRevision: second.revision,
        status: "complete",
      })
      yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_account_replacement"),
        objective: SessionGoal.Objective.make("Replacement goal"),
      })
      const staleGoal = yield* goals
        .account({
          sessionID,
          goalID: completed.id,
          expectedRevision: completed.revision,
          tokenDelta: 1,
          activeTimeMsDelta: 1,
        })
        .pipe(Effect.flip)

      expect(first).toMatchObject({ tokensUsed: 3, timeUsedSeconds: 1, status: "active" })
      expect(second).toMatchObject({ tokensUsed: 5, timeUsedSeconds: 2, status: "active" })
      expect(staleGoal._tag).toBe("SessionGoal.ConflictError")
    }),
  )

  it.effect("checkpoints one in-flight attempt after a guarded stop without reviving it", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_stopped_account"),
        objective: SessionGoal.Objective.make("Preserve terminal accounting"),
      })
      const paused = yield* goals.status({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        status: "paused",
      })
      const checkpointed = yield* goals.account({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        tokenDelta: 7,
        activeTimeMsDelta: 1_200,
        mode: "ActiveOrStopped",
      })
      const duplicate = yield* goals
        .account({
          sessionID,
          goalID: created.id,
          expectedRevision: created.revision,
          tokenDelta: 7,
          activeTimeMsDelta: 1_200,
          mode: "ActiveOrStopped",
        })
        .pipe(Effect.flip)

      expect(paused).toMatchObject({ revision: 2, status: "paused" })
      expect(checkpointed).toMatchObject({
        revision: 3,
        status: "paused",
        tokensUsed: 7,
        timeUsedSeconds: 1,
      })
      expect(duplicate._tag).toBe("SessionGoal.ConflictError")
    }),
  )

  it.effect("deduplicates provider-turn accounting durably and rejects conflicting checkpoint reuse", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      const { db } = yield* Database.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_turn_dedupe"),
        objective: SessionGoal.Objective.make("Count each provider turn exactly once"),
      })
      const checkpointID = SessionMessage.ID.make("msg_goal_turn_dedupe")
      const input = {
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        checkpointID,
        tokenDelta: 6,
        activeTimeMsDelta: 1_500,
        mode: "ActiveOrStopped" as const,
      }

      const accounted = yield* goals.account(input)
      const retried = yield* goals.account(input)
      const conflict = yield* goals.account({ ...input, tokenDelta: 7 }).pipe(Effect.flip)

      expect(retried).toEqual(accounted)
      expect(accounted).toMatchObject({
        revision: 2,
        status: "active",
        tokensUsed: 6,
        timeUsedSeconds: 1,
      })
      expect(conflict).toMatchObject({
        _tag: "SessionGoal.ConflictError",
        actualGoalID: created.id,
        actualRevision: 2,
      })
      expect(
        yield* db
          .select()
          .from(SessionGoalTurnTable)
          .where(eq(SessionGoalTurnTable.assistant_message_id, checkpointID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        expect.objectContaining({
          session_id: sessionID,
          goal_id: created.id,
          goal_revision: 2,
          token_delta: 6,
          active_time_ms_delta: 1_500,
        }),
      ])
    }),
  )

  it.effect("persists pause before interrupt and emits full snapshots plus a clear event", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.goal.set({
        sessionID,
        id: SessionGoal.ID.make("goal_pause"),
        messageID: SessionMessage.ID.make("msg_goal_pause"),
        objective: SessionGoal.Objective.make("Pause safely"),
      })
      interruptCalls.length = 0
      const paused = yield* session.goal.status({
        sessionID,
        goalID: created.id,
        expectedRevision: created.revision,
        status: "paused",
      })
      yield* session.goal.clear({
        sessionID,
        goalID: paused.id,
        expectedRevision: paused.revision,
      })
      const events = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(interruptCalls[0]).toEqual({ sessionID, status: "paused" })
      expect(events.map((event) => event.type)).toContain(EventV2.versionedType(SessionEvent.Goal.Cleared.type, 1))
      expect(
        events.find((event) => event.type === EventV2.versionedType(SessionEvent.Goal.Updated.type, 1))?.data,
      ).toMatchObject({ goal: { id: created.id, objective: created.objective, status: "active" } })
      expect(yield* session.goal.get(sessionID)).toBeUndefined()
    }),
  )
})

test("goal projection stays writer-consistent with the real SQLite reader pool", async () => {
  await using tmp = await tmpdir()
  const database = Database.layerFromPath(path.join(tmp.path, "goal.sqlite"))
  const app = AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionStore.node, SessionGoal.node]),
    [[Database.node, database]],
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: location, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "replicas",
          directory: location,
          title: "replicas",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const goals = yield* SessionGoal.Service
      const created = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_replicas"),
        objective: SessionGoal.Objective.make("Use the writer projection"),
      })

      const current = yield* Ref.make(created)
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          Ref.get(current).pipe(
            Effect.flatMap((goal) =>
              goals.edit({
                sessionID,
                goalID: goal.id,
                expectedRevision: goal.revision,
                objective: SessionGoal.Objective.make(`Writer revision ${index + 1}`),
              }),
            ),
            Effect.flatMap((goal) => Ref.set(current, goal)),
          ),
        { discard: true },
      )
      const final = yield* Ref.get(current)

      expect(final).toMatchObject({ revision: 21, objective: "Writer revision 20" })
    }).pipe(Effect.orDie, Effect.provide(app), Effect.scoped),
  )
})

test("provider-turn accounting remains exactly once across a file-backed service restart", async () => {
  await using tmp = await tmpdir()
  const databasePath = path.join(tmp.path, "goal-turn.sqlite")
  const goalID = SessionGoal.ID.make("goal_turn_restart")
  const checkpointID = SessionMessage.ID.make("msg_goal_turn_restart")
  const input = {
    sessionID,
    goalID,
    expectedRevision: SessionGoal.Revision.make(1),
    checkpointID,
    tokenDelta: 5,
    activeTimeMsDelta: 2_000,
    mode: "ActiveOrStopped" as const,
  }
  const app = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionStore.node, SessionGoal.node]), [
      [Database.node, Database.layerFromPath(databasePath)],
    ])

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: location, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "turn-restart",
          directory: location,
          title: "turn-restart",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        id: goalID,
        objective: SessionGoal.Objective.make("Preserve accounting across restart"),
      })
      expect(yield* goals.account(input)).toMatchObject({
        revision: 2,
        status: "active",
        tokensUsed: 5,
        timeUsedSeconds: 2,
      })
    }).pipe(Effect.orDie, Effect.provide(app()), Effect.scoped),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const goals = yield* SessionGoal.Service
      expect(yield* goals.account(input)).toMatchObject({
        revision: 2,
        status: "active",
        tokensUsed: 5,
        timeUsedSeconds: 2,
      })
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionGoalTurnTable)
          .where(eq(SessionGoalTurnTable.assistant_message_id, checkpointID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }).pipe(Effect.orDie, Effect.provide(app()), Effect.scoped),
  )
})
