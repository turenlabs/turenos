import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamTaskTable } from "@turenlabs/core/team/workspace.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, TeamWorkspace.node])))

const setup = Effect.gen(function* () {
  const team = yield* TeamWorkspace.Service
  const db = (yield* Database.Service).db
  const mate = yield* team.createTeammate({ name: "Worker", handle: "worker", role: "Worker", mission: "Work" })
  const [task] = (yield* team.postMessage({ id: "msg_assignment", text: "@worker begin" })).tasks
  yield* team.claimTasks({ owner: "owner" })
  yield* team.startTask({ id: task!.id, owner: "owner" })
  const sessionID = SessionSchema.ID.make(task!.sessionID)
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectV2.ID.global,
      worktree: AbsolutePath.make("/project"),
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: "output",
      directory: "/project",
      title: "Output",
      version: "test",
    })
    .run()
  return { team, db, mate, task: task!, sessionID }
})

// Invalid, large payloads make an accidental transcript read fail. These tests use metadata and durable events only.
function message(sessionID: SessionSchema.ID, id: string, seq: number, type: "user" | "assistant" = "assistant") {
  return Database.Service.use(({ db }) =>
    db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: sessionID,
        seq,
        type,
        data: sql`${JSON.stringify({ unreadable: "x".repeat(1024 * 1024) })}`,
      })
      .run(),
  )
}

function ended(sessionID: SessionSchema.ID, assistantMessageID: string, finish = "stop") {
  return EventV2.Service.use((events) =>
    events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID: SessionMessage.ID.make(assistantMessageID),
      timestamp: DateTime.makeUnsafe(1),
      finish,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
}

describe("Team Session output recovery", () => {
  it.effect("pages completion metadata across tool finishes and replies appended between pages", () =>
    Effect.gen(function* () {
      const { team, sessionID } = yield* setup
      yield* message(sessionID, "msg_tool", 1)
      yield* ended(sessionID, "msg_tool", "tool-calls")
      const first = yield* team.sessionOutputPage({ sessionID, limit: 1 })
      expect(first.messageIDs).toEqual([])
      expect(first.next).toBeDefined()
      yield* message(sessionID, "msg_final", 2)
      yield* ended(sessionID, "msg_final")
      const second = yield* team.sessionOutputPage({ sessionID, after: first.next, limit: 1 })
      expect(second.messageIDs).toEqual(["msg_final"])
      const last = yield* team.sessionOutputPage({ sessionID, after: second.next, limit: 1 })
      expect(last).toEqual({ messageIDs: [], next: undefined })
      for (const input of [{ limit: 101 }, { after: -2 }, { limit: 0 }])
        expect(yield* team.sessionOutputPage({ sessionID, ...input }).pipe(Effect.flip)).toBeInstanceOf(
          TeamWorkspace.InvalidRequestError,
        )
    }),
  )

  it.effect("attributes replies to real task prompts, not task-like follow-up IDs or later tasks", () =>
    Effect.gen(function* () {
      const { team, db, task, sessionID } = yield* setup
      yield* message(sessionID, `msg_team_${task.id}`, 1, "user")
      yield* message(sessionID, "msg_first", 2)
      yield* message(sessionID, "msg_team_runtime_followup", 3, "user")
      yield* message(sessionID, "msg_followup", 4)
      yield* team.finishTask({ id: task.id, owner: "owner", status: "succeeded", text: "Done" })
      const [later] = (yield* team.postMessage({ id: "msg_second_assignment", text: "@worker next" })).tasks
      yield* db
        .update(TeamTaskTable)
        .set({ session_id: sessionID, status: "succeeded" })
        .where(eq(TeamTaskTable.id, later!.id))
        .run()
      yield* message(sessionID, `msg_team_${later!.id}`, 5, "user")
      yield* message(sessionID, "msg_later", 6)
      expect(yield* team.sessionOutputTask({ sessionID, assistantMessageID: "msg_first" })).toBe(task.id)
      expect(yield* team.sessionOutputTask({ sessionID, assistantMessageID: "msg_followup" })).toBe(task.id)
      expect(yield* team.sessionOutputTask({ sessionID, assistantMessageID: "msg_later" })).toBe(later!.id)
      expect(
        yield* team.sessionOutputTask({ sessionID: "ses_unrelated", assistantMessageID: "msg_first" }),
      ).toBeUndefined()
      expect(yield* team.sessionOutputTask({ sessionID, assistantMessageID: "msg_missing" })).toBeUndefined()
    }),
  )

  it.effect("skips durable task reports and published replies before any transcript decoding", () =>
    Effect.gen(function* () {
      const { team, task, sessionID } = yield* setup
      yield* message(sessionID, `msg_team_${task.id}`, 1, "user")
      yield* message(sessionID, "msg_final", 2)
      yield* ended(sessionID, "msg_final")
      yield* team.finishTask({
        id: task.id,
        owner: "owner",
        status: "succeeded",
        text: "Done",
        sourceMessageIDs: ["msg_final"],
      })
      expect(
        yield* team.sessionOutputTask({ sessionID, assistantMessageID: "msg_final", recovery: true }),
      ).toBeUndefined()
      yield* message(sessionID, "msg_followup", 3)
      yield* ended(sessionID, "msg_followup")
      const input = { sessionID, assistantMessageID: "msg_followup", recovery: true }
      expect(yield* team.sessionOutputTask(input)).toBe(task.id)
      yield* team.publishSessionOutput({ ...input, taskID: task.id, text: "Follow-up" })
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      expect((yield* team.sessionOutputPage({ sessionID })).messageIDs).toEqual(["msg_final", "msg_followup"])
    }),
  )

  it.effect("does not fall back to an older task when the nearest task is paused or archived", () =>
    Effect.gen(function* () {
      const { team, db, task, sessionID } = yield* setup
      yield* db.update(TeamTaskTable).set({ status: "succeeded" }).where(eq(TeamTaskTable.id, task.id)).run()
      const room = yield* team.createRoom({ name: "second-room" })
      const mate = yield* team.createTeammate({
        roomID: room.id,
        name: "Next",
        handle: "next",
        role: "Worker",
        mission: "Work",
      })
      const [next] = (yield* team.postMessage({ roomID: room.id, id: "msg_next_assignment", text: "@next begin" }))
        .tasks
      yield* db
        .update(TeamTaskTable)
        .set({ session_id: sessionID, status: "succeeded" })
        .where(eq(TeamTaskTable.id, next!.id))
        .run()
      yield* message(sessionID, `msg_team_${task.id}`, 1, "user")
      yield* message(sessionID, `msg_team_${next!.id}`, 2, "user")
      yield* message(sessionID, "msg_answer", 3)
      const input = { sessionID, assistantMessageID: "msg_answer", recovery: true }
      yield* team.editTeammate({ id: mate.id, status: "paused" })
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      yield* team.editTeammate({ id: mate.id, status: "active" })
      expect(yield* team.sessionOutputTask(input)).toBe(next!.id)
      yield* team.archiveRoom(room.id)
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      yield* team.restoreRoom(room.id)
      expect(yield* team.sessionOutputTask(input)).toBe(next!.id)
    }),
  )

  it.effect("retries deferred output after lease expiry, task settlement, and room restoration", () =>
    Effect.gen(function* () {
      const { team, db, task, mate, sessionID } = yield* setup
      yield* message(sessionID, `msg_team_${task.id}`, 1, "user")
      yield* message(sessionID, "msg_final", 2)
      yield* ended(sessionID, "msg_final")
      const input = { sessionID, assistantMessageID: "msg_final", recovery: true }
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      yield* db.update(TeamTaskTable).set({ lease_expires_at: 0 }).where(eq(TeamTaskTable.id, task.id)).run()
      expect(yield* team.sessionOutputTask({ ...input, recovery: false })).toBeUndefined()
      expect(yield* team.sessionOutputTask(input)).toBe(task.id)
      yield* db.update(TeamTaskTable).set({ status: "cancelled" }).where(eq(TeamTaskTable.id, task.id)).run()
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      yield* db.update(TeamTaskTable).set({ status: "stale" }).where(eq(TeamTaskTable.id, task.id)).run()
      expect(yield* team.sessionOutputTask(input)).toBe(task.id)
      yield* db.update(TeamTaskTable).set({ status: "failed" }).where(eq(TeamTaskTable.id, task.id)).run()
      yield* team.editTeammate({ id: mate.id, status: "paused" })
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      yield* team.editTeammate({ id: mate.id, status: "active" })
      yield* team.archiveRoom(task.roomID)
      expect(yield* team.sessionOutputTask(input)).toBeUndefined()
      yield* team.restoreRoom(task.roomID)
      expect(yield* team.sessionOutputTask(input)).toBe(task.id)
    }),
  )
})
