import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionMessageTable } from "@turenlabs/core/session/sql"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamMessageTable, TeamTaskTable } from "@turenlabs/core/team/workspace.sql"
import { reconcileSessionOutputs } from "../../src/team/runtime"
import { recoveryLayer, seedRecoveryTask } from "../fixture/team-output-recovery"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(recoveryLayer())

it.live("recovers missed output across pages and retries late completion without a cursor", () =>
  Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const sessions = yield* SessionV2.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const fixture = yield* seedRecoveryTask("pages", 205, 1024)
    const lateID = SessionMessage.ID.make("msg_pages_0")
    const late = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, lateID)).get()
    yield* db
      .update(SessionMessageTable)
      .set({ data: { ...late!.data, time: { created: 2 } } })
      .where(eq(SessionMessageTable.id, lateID))
      .run()
    // A live lease must keep the output unpublished, even when the response already completed.
    yield* reconcileSessionOutputs
    expect((yield* team.state()).messages.filter((message) => message.sourceMessageIDs?.length)).toHaveLength(0)
    expect(yield* sessions.pendingInputs(fixture.sessionID)).toHaveLength(1)
    yield* db.update(TeamTaskTable).set({ lease_expires_at: 0 }).where(eq(TeamTaskTable.id, fixture.task.id)).run()
    yield* reconcileSessionOutputs
    expect(
      yield* db.select().from(TeamMessageTable).where(eq(TeamMessageTable.session_id, fixture.sessionID)).all(),
    ).toHaveLength(204)
    yield* db.update(SessionMessageTable).set({ data: late!.data }).where(eq(SessionMessageTable.id, lateID)).run()
    yield* reconcileSessionOutputs
    expect(yield* team.sessionOutputCandidates({ sessionID: fixture.sessionID })).toEqual([])
    const published = yield* db
      .select()
      .from(TeamMessageTable)
      .where(eq(TeamMessageTable.session_id, fixture.sessionID))
      .all()
    expect(published).toHaveLength(205)
    expect(published.find((message) => message.source_message_ids?.includes(lateID))?.text).toBe("Recovered pages 0")
    yield* Effect.forEach([0, 1, 2], () => reconcileSessionOutputs, { concurrency: 3 })
    expect(
      yield* db.select().from(TeamMessageTable).where(eq(TeamMessageTable.session_id, fixture.sessionID)).all(),
    ).toEqual(published)
    expect((yield* team.getTask(fixture.task.id)).status).toBe("running")
  }),
)

it.live("keeps cancelled output private and separates Session task boundaries and durable final results", () =>
  Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const cancelled = yield* seedRecoveryTask("cancelled")
    yield* team.cancelTask(cancelled.task.id)
    const completed = yield* seedRecoveryTask("completed", 2)
    yield* team.finishTask({
      id: completed.task.id,
      owner: "completed",
      status: "succeeded",
      text: "Final",
      sourceMessageIDs: ["msg_completed_1"],
    })
    yield* team.editTeammate({ id: completed.mate.id, status: "paused" })
    yield* reconcileSessionOutputs
    expect(
      yield* db.select().from(TeamMessageTable).where(eq(TeamMessageTable.session_id, completed.sessionID)).all(),
    ).toHaveLength(1)
    yield* team.editTeammate({ id: completed.mate.id, status: "active" })
    yield* reconcileSessionOutputs
    expect(
      yield* db.select().from(TeamMessageTable).where(eq(TeamMessageTable.session_id, cancelled.sessionID)).all(),
    ).toEqual([])
    const outputs = yield* db
      .select()
      .from(TeamMessageTable)
      .where(eq(TeamMessageTable.session_id, completed.sessionID))
      .all()
    expect(outputs).toHaveLength(2)
    expect(outputs.map((message) => message.text).sort()).toEqual(["Final", "Recovered completed 0"])
    expect(
      yield* team.publishSessionOutput({
        sessionID: completed.sessionID,
        taskID: cancelled.task.id,
        assistantMessageID: "msg_wrong_session",
        text: "Private",
        recovery: true,
      }),
    ).toBeUndefined()
    yield* reconcileSessionOutputs
    expect(
      yield* db.select().from(TeamMessageTable).where(eq(TeamMessageTable.session_id, completed.sessionID)).all(),
    ).toEqual(outputs)
  }),
)

testEffect(Layer.empty).live("reopens durable service state and recovers missed output exactly once", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({})),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const filename = `${directory.path}/recovery.sqlite`
    const fixture = yield* Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const fixture = yield* seedRecoveryTask("restart", 2)
      yield* team.finishTask({
        id: fixture.task.id,
        owner: "restart",
        status: "succeeded",
        text: "Final",
        sourceMessageIDs: ["msg_restart_1"],
      })
      return fixture
    }).pipe(Effect.provide(recoveryLayer(filename)), Effect.scoped)
    const recover = Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const sessions = yield* SessionV2.Service
      yield* sessions.prompt(fixture.prompt)
      expect(yield* sessions.pendingInputs(fixture.sessionID)).toHaveLength(1)
      yield* reconcileSessionOutputs
      const state = yield* team.state()
      const outputs = state.messages.filter((message) => message.sessionID === fixture.sessionID)
      expect(outputs.map((message) => message.text).sort()).toEqual(["Final", "Recovered restart 0"])
      expect(yield* team.sessionOutputCandidates({ sessionID: fixture.sessionID })).toEqual([])
      return outputs.map((message) => ({ id: message.id, seq: message.seq, source: message.sourceMessageIDs }))
    })
    const first = yield* recover.pipe(Effect.provide(recoveryLayer(filename)), Effect.scoped)
    const second = yield* recover.pipe(Effect.provide(recoveryLayer(filename)), Effect.scoped)
    expect(second).toEqual(first)
  }),
)
