import { expect, test } from "bun:test"
import path from "path"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionCommand } from "@turenlabs/core/session/command"
import { SessionGoal } from "@turenlabs/core/session/goal"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionRevert } from "@turenlabs/core/session/revert"
import { SessionShell } from "@turenlabs/core/session/shell"
import {
  SessionInputTable,
  SessionMessageIdentityTable,
  SessionMessageTable,
  SessionTable,
} from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { Snapshot } from "@turenlabs/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const model = ModelV2.Ref.make({
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
  variant: ModelV2.VariantID.make("default"),
})
const commandAgent = AgentV2.ID.make("reviewer")
const commandModel = ModelV2.Ref.make({
  id: ModelV2.ID.make("review-model"),
  providerID: ProviderV2.ID.make("provider"),
  variant: ModelV2.VariantID.make("high"),
})
let commandRevision = 0
const commands = Layer.succeed(
  SessionCommand.Service,
  SessionCommand.Service.of({
    resolve: (input) =>
      Effect.succeed({
        prompt: { text: commandRevision === 0 ? "Review atomically" : "Changed configured command" },
        agent: commandRevision > 0 || input.arguments === "changed-agent" ? AgentV2.ID.make("other") : commandAgent,
        model:
          commandRevision > 0 || input.arguments === "changed-model"
            ? ModelV2.Ref.make({ ...commandModel, id: ModelV2.ID.make("other-model") })
            : commandModel,
      }),
  }),
)

test("reader-pooled Session admission commits staged revert only for genuinely new work", async () => {
  await using tmp = await tmpdir()
  const database = Database.layerFromPath(path.join(tmp.path, "revert.sqlite"))
  const replayDatabase = Database.layerFromPath(path.join(tmp.path, "replay.sqlite"))
  const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
  let wakeCount = 0
  const execution = Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      claimResume: () => Effect.succeed(Effect.void),
      resume: () => Effect.void,
      wake: () =>
        Effect.sync(() => {
          wakeCount++
        }),
      interrupt: () => Effect.void,
    }),
  )
  const app = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionGoal.node,
      SessionV2.node,
    ]),
    [
      [Database.node, database],
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
      [SessionCommand.node, commands],
      [Snapshot.node, Snapshot.noopLayer],
    ],
  )
  const replayApp = AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
    [[Database.node, replayDatabase]],
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = isWithReplicas(database.db) ? database.db.$primary : database.db
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const store = yield* SessionStore.Service
      expect(isWithReplicas(database.db)).toBe(true)

      const startTail = Effect.fnUntraced(function* (sessionID: SessionV2.ID, assistantMessageID: SessionMessage.ID) {
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(10),
          agent: "build",
          model,
        })
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(11),
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })
      const promote = (sessionID: SessionV2.ID) =>
        SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      const commitSessionID = SessionV2.ID.make("ses_revert_new_admission")
      const boundaryID = SessionMessage.ID.make("msg_revert_new_boundary")
      const tailID = SessionMessage.ID.make("msg_revert_new_tail")
      const nextID = SessionMessage.ID.make("msg_revert_new_prompt")
      yield* session.create({ id: commitSessionID, location })
      yield* session.prompt({
        id: boundaryID,
        sessionID: commitSessionID,
        prompt: { text: "Keep this boundary" },
        resume: false,
      })
      yield* promote(commitSessionID)
      yield* startTail(commitSessionID, tailID)
      yield* session.revert.stage({ sessionID: commitSessionID, messageID: boundaryID, files: false })
      expect(yield* session.get(commitSessionID)).toMatchObject({
        revert: { messageID: boundaryID },
      })

      yield* session.prompt({
        id: nextID,
        sessionID: commitSessionID,
        prompt: { text: "Start from the staged boundary" },
        resume: false,
      })

      expect((yield* session.get(commitSessionID)).revert).toBeUndefined()
      expect(
        (yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, commitSessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)).map((row) => row.id),
      ).toEqual([boundaryID])
      expect(yield* SessionInput.find(db, nextID)).toMatchObject({
        id: nextID,
        sessionID: commitSessionID,
        prompt: { text: "Start from the staged boundary" },
      })

      const commandCommitSessionID = SessionV2.ID.make("ses_revert_new_command")
      const commandCommitBoundaryID = SessionMessage.ID.make("msg_revert_command_boundary")
      const commandCommitTailID = SessionMessage.ID.make("msg_revert_command_tail")
      const commandCommitID = SessionMessage.ID.make("msg_revert_command_admission")
      yield* session.create({ id: commandCommitSessionID, location })
      yield* session.prompt({
        id: commandCommitBoundaryID,
        sessionID: commandCommitSessionID,
        prompt: { text: "Keep this command boundary" },
        resume: false,
      })
      yield* promote(commandCommitSessionID)
      yield* startTail(commandCommitSessionID, commandCommitTailID)
      yield* session.revert.stage({
        sessionID: commandCommitSessionID,
        messageID: commandCommitBoundaryID,
        files: false,
      })
      commandRevision = 0
      yield* session.command({
        id: commandCommitID,
        sessionID: commandCommitSessionID,
        command: "review",
        arguments: "",
        resume: false,
      })

      expect((yield* session.get(commandCommitSessionID)).revert).toBeUndefined()
      expect(yield* store.message(commandCommitTailID)).toBeUndefined()
      expect(yield* SessionInput.findCommand(db, commandCommitID)).toEqual({
        command: "review",
        arguments: "",
      })
      expect(yield* SessionInput.findIdentity(db, commandCommitID)).toMatchObject({
        owner: "input",
        kind: "command",
        state: "active",
      })

      const goalCommitSessionID = SessionV2.ID.make("ses_revert_new_goal")
      const goalCommitBoundaryID = SessionMessage.ID.make("msg_revert_goal_commit_boundary")
      const goalCommitTailID = SessionMessage.ID.make("msg_revert_goal_commit_tail")
      const goalCommitMessageID = SessionMessage.ID.make("msg_revert_goal_commit_admission")
      yield* session.create({ id: goalCommitSessionID, location })
      yield* session.prompt({
        id: goalCommitBoundaryID,
        sessionID: goalCommitSessionID,
        prompt: { text: "Keep this goal boundary" },
        resume: false,
      })
      yield* promote(goalCommitSessionID)
      yield* startTail(goalCommitSessionID, goalCommitTailID)
      yield* session.revert.stage({
        sessionID: goalCommitSessionID,
        messageID: goalCommitBoundaryID,
        files: false,
      })
      const committedGoal = yield* session.goal.set({
        sessionID: goalCommitSessionID,
        id: SessionGoal.ID.make("goal_revert_commit"),
        messageID: goalCommitMessageID,
        objective: SessionGoal.Objective.make("Commit the goal and revert atomically"),
      })

      expect((yield* session.get(goalCommitSessionID)).revert).toBeUndefined()
      expect(yield* store.message(goalCommitTailID)).toBeUndefined()
      expect(yield* session.goal.get(goalCommitSessionID)).toEqual(committedGoal)
      expect(yield* SessionInput.findIdentity(db, goalCommitMessageID)).toMatchObject({
        owner: "input",
        kind: "goal",
        state: "active",
      })

      const retrySessionID = SessionV2.ID.make("ses_revert_exact_retry")
      const retryID = SessionMessage.ID.make("msg_revert_exact_boundary")
      const retryTailID = SessionMessage.ID.make("msg_revert_exact_tail")
      yield* session.create({ id: retrySessionID, location })
      const admitted = yield* session.prompt({
        id: retryID,
        sessionID: retrySessionID,
        prompt: { text: "Retry this exact prompt" },
        resume: false,
      })
      yield* promote(retrySessionID)
      yield* startTail(retrySessionID, retryTailID)
      yield* session.revert.stage({ sessionID: retrySessionID, messageID: retryID, files: false })

      expect(
        yield* session.prompt({
          id: retryID,
          sessionID: retrySessionID,
          prompt: { text: "Retry this exact prompt" },
          resume: false,
        }),
      ).toEqual({ ...admitted, promotedSeq: expect.anything() })
      expect(yield* session.get(retrySessionID)).toMatchObject({
        revert: { messageID: retryID },
      })
      expect(yield* session.message({ sessionID: retrySessionID, messageID: retryTailID })).toMatchObject({
        id: retryTailID,
        type: "assistant",
      })

      const goalRetrySessionID = SessionV2.ID.make("ses_revert_goal_exact_retry")
      const goalID = SessionGoal.ID.make("goal_revert_exact_retry")
      const goalMessageID = SessionMessage.ID.make("msg_revert_goal_boundary")
      const goalTailID = SessionMessage.ID.make("msg_revert_goal_tail")
      const objective = SessionGoal.Objective.make("Retry this exact goal")
      yield* session.create({ id: goalRetrySessionID, location })
      const createdGoal = yield* session.goal.set({
        sessionID: goalRetrySessionID,
        id: goalID,
        messageID: goalMessageID,
        objective,
      })
      yield* promote(goalRetrySessionID)
      yield* startTail(goalRetrySessionID, goalTailID)
      yield* session.revert.stage({
        sessionID: goalRetrySessionID,
        messageID: goalMessageID,
        files: false,
      })

      expect(
        yield* session.goal.set({
          sessionID: goalRetrySessionID,
          id: goalID,
          messageID: goalMessageID,
          objective,
        }),
      ).toEqual(createdGoal)
      expect(yield* session.get(goalRetrySessionID)).toMatchObject({
        revert: { messageID: goalMessageID },
      })
      expect(yield* session.message({ sessionID: goalRetrySessionID, messageID: goalTailID })).toMatchObject({
        id: goalTailID,
        type: "assistant",
      })

      const goalCollisionSessionID = SessionV2.ID.make("ses_revert_goal_message_collision")
      const goalCollisionBoundaryID = SessionMessage.ID.make("msg_revert_goal_collision_boundary")
      const goalCollisionTailID = SessionMessage.ID.make("msg_revert_goal_collision_tail")
      const goalCollisionMessageID = SessionMessage.ID.make("msg_revert_goal_collision_input")
      yield* session.create({ id: goalCollisionSessionID, location })
      yield* session.prompt({
        id: goalCollisionBoundaryID,
        sessionID: goalCollisionSessionID,
        prompt: { text: "Keep this goal collision boundary" },
        resume: false,
      })
      yield* promote(goalCollisionSessionID)
      yield* startTail(goalCollisionSessionID, goalCollisionTailID)
      yield* session.prompt({
        id: goalCollisionMessageID,
        sessionID: goalCollisionSessionID,
        prompt: { text: "Already admitted as a regular prompt" },
        resume: false,
      })
      yield* session.revert.stage({
        sessionID: goalCollisionSessionID,
        messageID: goalCollisionBoundaryID,
        files: false,
      })

      expect(
        yield* session.goal
          .set({
            sessionID: goalCollisionSessionID,
            id: SessionGoal.ID.make("goal_revert_message_collision"),
            messageID: goalCollisionMessageID,
            objective: SessionGoal.Objective.make("Must not consume the staged revert"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
      expect(yield* session.get(goalCollisionSessionID)).toMatchObject({
        revert: { messageID: goalCollisionBoundaryID },
      })
      expect(
        yield* session.message({
          sessionID: goalCollisionSessionID,
          messageID: goalCollisionTailID,
        }),
      ).toMatchObject({ id: goalCollisionTailID, type: "assistant" })
      expect(yield* session.goal.get(goalCollisionSessionID)).toBeUndefined()

      const guardedSessionID = SessionV2.ID.make("ses_revert_goal_guard")
      const guardedBoundaryID = SessionMessage.ID.make("msg_revert_goal_guard_boundary")
      const guardedGoalID = SessionGoal.ID.make("goal_revert_guard")
      const guardedGoalMessageID = SessionMessage.ID.make("msg_revert_goal_guard_input")
      const guardedPromptID = SessionMessage.ID.make("msg_revert_goal_guard_prompt")
      const guardedObjective = SessionGoal.Objective.make("Preserve the active goal admission")
      yield* session.create({ id: guardedSessionID, location })
      yield* session.prompt({
        id: guardedBoundaryID,
        sessionID: guardedSessionID,
        prompt: { text: "This boundary predates the goal" },
        resume: false,
      })
      yield* promote(guardedSessionID)
      const guardedGoal = yield* session.goal.set({
        sessionID: guardedSessionID,
        id: guardedGoalID,
        messageID: guardedGoalMessageID,
        objective: guardedObjective,
      })
      yield* session.revert.stage({
        sessionID: guardedSessionID,
        messageID: guardedBoundaryID,
        files: false,
      })
      const goals = yield* SessionGoal.Service
      const [accountedGoal, blockedCommit] = yield* Effect.all(
        [
          goals.account({
            sessionID: guardedSessionID,
            goalID: guardedGoal.id,
            expectedRevision: guardedGoal.revision,
            tokenDelta: 5,
            activeTimeMsDelta: 100,
          }),
          session.revert.commit(guardedSessionID).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )

      expect(blockedCommit).toBeInstanceOf(SessionRevert.GoalBoundaryError)
      expect(yield* session.get(guardedSessionID)).toMatchObject({
        revert: { messageID: guardedBoundaryID },
      })
      expect(yield* session.goal.get(guardedSessionID)).toEqual(accountedGoal)
      expect(yield* SessionInput.find(db, guardedGoalMessageID)).toMatchObject({
        id: guardedGoalMessageID,
        sessionID: guardedSessionID,
      })
      expect(
        yield* session
          .prompt({
            id: guardedPromptID,
            sessionID: guardedSessionID,
            prompt: { text: "Do not erase the active goal admission" },
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionRevert.GoalBoundaryError)
      expect(yield* SessionInput.find(db, guardedPromptID)).toBeUndefined()
      expect(
        yield* session.goal.set({
          sessionID: guardedSessionID,
          id: guardedGoalID,
          messageID: guardedGoalMessageID,
          objective: guardedObjective,
        }),
      ).toEqual(accountedGoal)

      const commandSessionID = SessionV2.ID.make("ses_command_atomic_routing")
      const commandMessageID = SessionMessage.ID.make("msg_command_atomic_routing")
      yield* session.create({ id: commandSessionID, location })
      const commandInput = {
        id: commandMessageID,
        sessionID: commandSessionID,
        command: "review",
        arguments: "",
        resume: false,
      } as const
      const command = yield* session.command(commandInput)
      expect(command).toMatchObject({
        id: commandMessageID,
        prompt: { text: "Review atomically" },
        agent: commandAgent,
        model: commandModel,
      })
      commandRevision = 1
      expect(yield* session.command(commandInput)).toEqual(command)
      expect(yield* session.command({ ...commandInput, arguments: "changed-agent" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionV2.PromptConflictError,
      )
      expect(yield* session.command({ ...commandInput, arguments: "changed-model" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionV2.PromptConflictError,
      )
      expect(
        yield* session.command({ ...commandInput, agent: AgentV2.ID.make("other") }).pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session
          .command({
            ...commandInput,
            model: ModelV2.Ref.make({ ...commandModel, id: ModelV2.ID.make("caller-change") }),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(yield* session.get(commandSessionID)).toMatchObject({
        agent: commandAgent,
        model: commandModel,
      })
      expect(
        yield* db
          .select({
            agent: SessionInputTable.agent,
            model: SessionInputTable.model,
            command: SessionInputTable.command,
          })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, commandMessageID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        agent: commandAgent,
        model: commandModel,
        command: {
          command: commandInput.command,
          arguments: commandInput.arguments,
        },
      })
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, commandSessionID))
          .all()
          .pipe(Effect.orDie)).filter(
          (event) => event.type === EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
        ),
      ).toHaveLength(1)
      const recorded = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, commandSessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      yield* Effect.gen(function* () {
        const replay = yield* EventV2.Service
        const replayStore = yield* SessionStore.Service
        const replayDb = Database.primary((yield* Database.Service).db)
        yield* replayDb
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* replay.replayAll(recorded)

        expect(yield* replayStore.get(commandSessionID)).toMatchObject({
          agent: commandAgent,
          model: commandModel,
        })
        expect(yield* SessionInput.find(replayDb, commandMessageID)).toMatchObject({
          agent: commandAgent,
          model: commandModel,
        })
        expect(yield* SessionInput.findCommand(replayDb, commandMessageID)).toEqual({
          command: commandInput.command,
          arguments: commandInput.arguments,
        })
      }).pipe(Effect.provide(Layer.fresh(replayApp)), Effect.scoped)

      const pendingSession = yield* session.create({
        id: SessionV2.ID.make("ses_identity_pending"),
        location,
      })
      const pendingID = SessionMessage.ID.make("msg_identity_pending")
      yield* session.prompt({
        sessionID: pendingSession.id,
        id: pendingID,
        prompt: { text: "Remain globally owned while pending" },
        resume: false,
      })
      expect(
        yield* session
          .shell({
            sessionID: pendingSession.id,
            id: pendingID,
            command: "printf shell",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionShell.ConflictError)
      yield* promote(pendingSession.id)
      expect(yield* store.message(pendingID)).toMatchObject({
        sessionID: pendingSession.id,
        message: { id: pendingID, type: "user" },
      })

      const commandOwner = yield* session.create({
        id: SessionV2.ID.make("ses_identity_command"),
        location,
      })
      const commandOwnerID = SessionMessage.ID.make("msg_identity_command")
      commandRevision = 0
      yield* session.command({
        sessionID: commandOwner.id,
        id: commandOwnerID,
        command: "review",
        arguments: "",
        resume: false,
      })
      expect(
        yield* session
          .shell({
            sessionID: commandOwner.id,
            id: commandOwnerID,
            command: "printf shell",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionShell.ConflictError)

      const goalOwner = yield* session.create({
        id: SessionV2.ID.make("ses_identity_goal"),
        location,
      })
      const goalOwnerID = SessionMessage.ID.make("msg_identity_goal")
      yield* session.goal.set({
        sessionID: goalOwner.id,
        id: SessionGoal.ID.make("goal_identity_owner"),
        messageID: goalOwnerID,
        objective: SessionGoal.Objective.make("Keep the goal admission globally owned"),
      })
      expect(
        yield* session
          .shell({
            sessionID: goalOwner.id,
            id: goalOwnerID,
            command: "printf shell",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionShell.ConflictError)

      const shellOwner = yield* session.create({
        id: SessionV2.ID.make("ses_identity_shell_owner"),
        location,
      })
      const shellOwnedID = SessionMessage.ID.make("msg_identity_shell_owned")
      yield* session.shell({
        sessionID: shellOwner.id,
        id: shellOwnedID,
        command: "printf shell",
      })
      const collisionVictim = yield* session.create({
        id: SessionV2.ID.make("ses_identity_collision_victim"),
        location,
      })
      const collisionBoundaryID = SessionMessage.ID.make("msg_identity_collision_boundary")
      const collisionTailID = SessionMessage.ID.make("msg_identity_collision_tail")
      yield* session.prompt({
        sessionID: collisionVictim.id,
        id: collisionBoundaryID,
        prompt: { text: "Preserve this staged revert" },
        resume: false,
      })
      yield* promote(collisionVictim.id)
      yield* startTail(collisionVictim.id, collisionTailID)
      yield* session.revert.stage({
        sessionID: collisionVictim.id,
        messageID: collisionBoundaryID,
        files: false,
      })
      expect(
        yield* session
          .prompt({
            sessionID: collisionVictim.id,
            id: shellOwnedID,
            prompt: { text: "Must not consume the revert" },
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session
          .command({
            sessionID: collisionVictim.id,
            id: shellOwnedID,
            command: "review",
            arguments: "",
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session.goal
          .set({
            sessionID: collisionVictim.id,
            id: SessionGoal.ID.make("goal_identity_collision"),
            messageID: shellOwnedID,
            objective: SessionGoal.Objective.make("Must not consume the staged revert"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
      expect(yield* session.get(collisionVictim.id)).toMatchObject({
        revert: { messageID: collisionBoundaryID },
      })
      expect(yield* store.message(collisionTailID)).toMatchObject({
        sessionID: collisionVictim.id,
      })

      const revertedSession = yield* session.create({
        id: SessionV2.ID.make("ses_identity_reverted"),
        location,
      })
      const revertedBoundaryID = SessionMessage.ID.make("msg_identity_reverted_boundary")
      const revertedID = SessionMessage.ID.make("msg_identity_reverted_input")
      yield* session.prompt({
        sessionID: revertedSession.id,
        id: revertedBoundaryID,
        prompt: { text: "Permanent identity boundary" },
        resume: false,
      })
      yield* promote(revertedSession.id)
      const original = yield* session.prompt({
        sessionID: revertedSession.id,
        id: revertedID,
        prompt: { text: "Never reuse this identity" },
        delivery: "steer",
        resume: false,
      })
      yield* session.revert.stage({
        sessionID: revertedSession.id,
        messageID: revertedBoundaryID,
        files: false,
      })
      const committed: EventV2.Payload[] = []
      const stopWatching = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionEvent.RevertEvent.Committed.type) committed.push(event)
        }),
      )
      yield* session.revert.commit(revertedSession.id)
      yield* stopWatching
      // Unlike stage and clear, commit needs no Location-scoped service, so it
      // runs on the Session service's global fiber with no Location.Service in
      // context. Without the placement passed at publish time the frame is
      // unlocated and every per-instance event stream drops it, so a client
      // watching this directory never learns the boundary was committed. See the
      // filter in packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
      expect(committed).toHaveLength(1)
      expect(committed[0]!.location?.directory).toBe(location.directory)
      const admissionCount = () =>
        db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, revertedSession.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map(
              (rows) =>
                rows.filter((row) => row.type === EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)).length,
            ),
          )
      const beforeRetry = yield* admissionCount()
      const beforeRetryWake = wakeCount
      expect(
        yield* session.prompt({
          sessionID: revertedSession.id,
          id: revertedID,
          prompt: { text: "Never reuse this identity" },
          delivery: "steer",
        }),
      ).toEqual(original)
      expect(yield* admissionCount()).toBe(beforeRetry)
      expect(wakeCount).toBe(beforeRetryWake)
      expect(yield* SessionInput.find(db, revertedID)).toBeUndefined()
      expect(yield* SessionInput.findIdentity(db, revertedID)).toMatchObject({
        owner: "input",
        kind: "prompt",
        state: "reverted",
      })
      expect(
        yield* session
          .prompt({
            sessionID: revertedSession.id,
            id: revertedID,
            prompt: { text: "Changed retry must conflict" },
            delivery: "queue",
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session
          .prompt({
            sessionID: revertedSession.id,
            id: revertedID,
            prompt: { text: "Never reuse this identity" },
            delivery: "steer",
            agent: AgentV2.ID.make("changed-agent"),
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session
          .prompt({
            sessionID: revertedSession.id,
            id: revertedID,
            prompt: { text: "Never reuse this identity" },
            delivery: "steer",
            model: ModelV2.Ref.make({
              providerID: ProviderV2.ID.make("changed-provider"),
              id: ModelV2.ID.make("changed-model"),
            }),
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session
          .command({
            sessionID: revertedSession.id,
            id: revertedID,
            command: "review",
            arguments: "",
            resume: false,
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(
        yield* session.goal
          .set({
            sessionID: revertedSession.id,
            id: SessionGoal.ID.make("goal_reverted_identity"),
            messageID: revertedID,
            objective: SessionGoal.Objective.make("Cannot reuse a reverted prompt identity"),
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionGoal.ConflictError)
      expect(
        yield* session
          .shell({
            sessionID: revertedSession.id,
            id: revertedID,
            command: "printf shell",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionShell.ConflictError)

      const revertedCommandSession = yield* session.create({
        id: SessionV2.ID.make("ses_identity_reverted_command"),
        location,
      })
      const revertedCommandBoundaryID = SessionMessage.ID.make("msg_identity_reverted_command_boundary")
      const revertedCommandID = SessionMessage.ID.make("msg_identity_reverted_command")
      yield* session.prompt({
        sessionID: revertedCommandSession.id,
        id: revertedCommandBoundaryID,
        prompt: { text: "Permanent command identity boundary" },
        resume: false,
      })
      yield* promote(revertedCommandSession.id)
      commandRevision = 0
      const originalCommand = yield* session.command({
        sessionID: revertedCommandSession.id,
        id: revertedCommandID,
        command: "review",
        arguments: "",
        resume: false,
      })
      yield* session.revert.stage({
        sessionID: revertedCommandSession.id,
        messageID: revertedCommandBoundaryID,
        files: false,
      })
      yield* session.revert.commit(revertedCommandSession.id)
      const revertedCommandAdmissions = () =>
        db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, revertedCommandSession.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map(
              (rows) =>
                rows.filter((row) => row.type === EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)).length,
            ),
          )
      const beforeCommandRetryEvents = yield* revertedCommandAdmissions()
      const beforeCommandRetryWake = wakeCount
      commandRevision = 1
      expect(
        yield* session.command({
          sessionID: revertedCommandSession.id,
          id: revertedCommandID,
          command: "review",
          arguments: "",
        }),
      ).toEqual(originalCommand)
      expect(yield* revertedCommandAdmissions()).toBe(beforeCommandRetryEvents)
      expect(wakeCount).toBe(beforeCommandRetryWake)
      expect(yield* SessionInput.find(db, revertedCommandID)).toBeUndefined()
      expect(yield* SessionInput.findIdentity(db, revertedCommandID)).toMatchObject({
        owner: "input",
        kind: "command",
        state: "reverted",
      })
      expect(
        yield* session
          .command({
            sessionID: revertedCommandSession.id,
            id: revertedCommandID,
            command: "review",
            arguments: "changed",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.PromptConflictError)

      const racedSession = yield* session.create({
        id: SessionV2.ID.make("ses_identity_raced_prompt"),
        location,
      })
      const racedShellSession = yield* session.create({
        id: SessionV2.ID.make("ses_identity_raced_shell"),
        location,
      })
      const racedBoundaryID = SessionMessage.ID.make("msg_identity_raced_boundary")
      const racedTailID = SessionMessage.ID.make("msg_identity_raced_tail")
      const racedID = SessionMessage.ID.make("msg_identity_raced")
      yield* session.prompt({
        sessionID: racedSession.id,
        id: racedBoundaryID,
        prompt: { text: "Atomic race boundary" },
        resume: false,
      })
      yield* promote(racedSession.id)
      yield* startTail(racedSession.id, racedTailID)
      yield* session.revert.stage({
        sessionID: racedSession.id,
        messageID: racedBoundaryID,
        files: false,
      })
      const [racedPrompt, racedShell] = yield* Effect.all(
        [
          session
            .prompt({
              sessionID: racedSession.id,
              id: racedID,
              prompt: { text: "Win atomically or preserve the revert" },
              resume: false,
            })
            .pipe(Effect.exit),
          session
            .shell({
              sessionID: racedShellSession.id,
              id: racedID,
              command: "printf shell",
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(Number(Exit.isSuccess(racedPrompt)) + Number(Exit.isSuccess(racedShell))).toBe(1)
      const racedState = yield* session.get(racedSession.id)
      const racedTail = yield* store.message(racedTailID)
      if (Exit.isSuccess(racedPrompt)) {
        expect(racedState.revert).toBeUndefined()
        expect(racedTail).toBeUndefined()
        yield* promote(racedSession.id)
        expect(yield* store.message(racedID)).toMatchObject({
          sessionID: racedSession.id,
          message: { type: "user" },
        })
      } else {
        expect(racedPrompt.cause.toString()).toContain("Session.PromptConflictError")
        expect(racedState).toMatchObject({ revert: { messageID: racedBoundaryID } })
        expect(racedTail).toMatchObject({ sessionID: racedSession.id })
      }
      expect(
        yield* db
          .select()
          .from(SessionMessageIdentityTable)
          .where(eq(SessionMessageIdentityTable.id, racedID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)

      const replaySession = yield* session.create({
        id: SessionV2.ID.make("ses_identity_composite_replay"),
        location,
      })
      const replayBoundaryID = SessionMessage.ID.make("msg_identity_replay_boundary")
      const replayTailID = SessionMessage.ID.make("msg_identity_replay_tail")
      const replayAdmissionID = SessionMessage.ID.make("msg_identity_replay_admission")
      yield* session.prompt({
        sessionID: replaySession.id,
        id: replayBoundaryID,
        prompt: { text: "Replay boundary" },
        resume: false,
      })
      yield* promote(replaySession.id)
      yield* startTail(replaySession.id, replayTailID)
      yield* session.revert.stage({
        sessionID: replaySession.id,
        messageID: replayBoundaryID,
        files: false,
      })
      yield* session.prompt({
        sessionID: replaySession.id,
        id: replayAdmissionID,
        prompt: { text: "Composite admission survives replay" },
        resume: false,
      })
      const replayEvents = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, replaySession.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      expect(
        replayEvents.find(
          (event) =>
            event.type === EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1) &&
            (event.data as { readonly messageID?: string }).messageID === replayAdmissionID,
        )?.data,
      ).toMatchObject({ messageID: replayAdmissionID, revert: { messageID: replayBoundaryID } })
      yield* Effect.gen(function* () {
        const replay = yield* EventV2.Service
        const replayStore = yield* SessionStore.Service
        const replayDb = Database.primary((yield* Database.Service).db)
        yield* replayDb
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* replay.replayAll(replayEvents)

        expect(yield* replayStore.get(replaySession.id)).toMatchObject({ revert: undefined })
        expect(yield* replayStore.message(replayTailID)).toBeUndefined()
        expect(yield* SessionInput.find(replayDb, replayAdmissionID)).toMatchObject({
          id: replayAdmissionID,
          prompt: { text: "Composite admission survives replay" },
        })
        expect(yield* SessionInput.findIdentity(replayDb, replayAdmissionID)).toMatchObject({
          owner: "input",
          kind: "prompt",
          state: "active",
        })
      }).pipe(Effect.provide(Layer.fresh(replayApp)), Effect.scoped)

      const immediateSessionID = SessionV2.ID.make("ses_primary_immediate")
      const immediatePromptID = SessionMessage.ID.make("msg_primary_immediate")
      const selected = ModelV2.Ref.make({
        id: ModelV2.ID.make("selected"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("high"),
      })
      const created = yield* session.create({ id: immediateSessionID, location })
      yield* session.prompt({
        id: immediatePromptID,
        sessionID: created.id,
        prompt: { text: "Read this immediately from the writer" },
        resume: false,
      })
      const goal = yield* session.goal.set({
        sessionID: created.id,
        id: SessionGoal.ID.make("goal_primary_immediate"),
        messageID: SessionMessage.ID.make("msg_goal_primary_immediate"),
        objective: SessionGoal.Objective.make("Keep immediate Session reads consistent"),
      })
      yield* session.switchModel({ sessionID: created.id, model: selected })

      expect(yield* store.get(created.id)).toMatchObject({ id: created.id, model: selected })
      expect(yield* SessionInput.find(db, immediatePromptID)).toMatchObject({
        id: immediatePromptID,
        sessionID: created.id,
      })
      expect(yield* session.goal.get(created.id)).toEqual(goal)
      expect(
        yield* db
          .select({ revert: SessionTable.revert })
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ revert: null })
    }).pipe(Effect.provide(app), Effect.scoped),
  )
})
