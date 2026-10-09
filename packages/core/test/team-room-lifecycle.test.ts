import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamTaskTable } from "@turenlabs/core/team/workspace.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node, TeamWorkspace.node])))

describe("Team room lifecycle", () => {
  it.effect("routes unmentioned chat to one coordinator with bounded shared history", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "history-binding" })
      const first = yield* team.createTeammate({
        roomID: room.id,
        name: "First",
        handle: "first",
        role: "Analyst",
        mission: "Reply",
      })
      yield* team.createTeammate({
        roomID: room.id,
        name: "Second",
        handle: "second",
        role: "Analyst",
        mission: "Reply",
      })
      const hello = yield* team.postMessage({ id: "msg_room_hello", roomID: room.id, text: "Hello there" })
      expect(hello.tasks).toHaveLength(1)
      expect(hello.tasks[0]?.teammateID).toBe(first.id)
      expect((yield* team.getTask(hello.tasks[0]!.id)).execution.prompt).toContain("Respond normally to greetings")
      yield* team.cancelTask(hello.tasks[0]!.id)
      const followup = yield* team.postMessage({
        id: "msg_room_followup",
        roomID: room.id,
        text: "Please continue",
      })
      expect(followup.tasks).toHaveLength(1)
      expect((yield* team.getTask(followup.tasks[0]!.id)).execution.prompt).toContain("You: Hello there")
    }),
  )

  it.effect("archives read-only, does not resume schedules on restore, and protects linked duties", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const loops = yield* Loop.Service
      const room = yield* team.createRoom({ name: "lifecycle-room", topic: "Initial" })
      const mate = yield* team.createTeammate({
        roomID: room.id,
        name: "Moss",
        handle: "moss",
        role: "Analyst",
        mission: "Review",
      })
      const duty = yield* loops.create({
        teammateID: mate.id,
        name: "Review schedule",
        prompt: "Review",
        intervalSeconds: 3600,
      })

      const archived = yield* team.archiveRoom(room.id)
      expect(archived.archived).toBe(true)
      expect((yield* loops.get(duty.id)).status).toBe("paused")
      expect(yield* team.editRoom({ id: room.id, topic: "Changed" }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
      expect(
        yield* team
          .createTeammate({ roomID: room.id, name: "New", handle: "new", role: "Role", mission: "Mission" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.ConflictError)
      expect(yield* loops.resume(duty.id).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      expect(yield* team.deleteRoom(room.id).pipe(Effect.flip)).toBeInstanceOf(TeamWorkspace.ConflictError)

      const restored = yield* team.restoreRoom(room.id)
      expect(restored.archived).toBe(false)
      expect((yield* loops.get(duty.id)).status).toBe("paused")
      expect(yield* team.deleteRoom("trm_team").pipe(Effect.flip)).toBeInstanceOf(TeamWorkspace.ConflictError)
    }),
  )

  it.effect("allows an exact message retry after archive without admitting a new message", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "retry-room" })
      const input = { id: "msg_archived_retry", roomID: room.id, text: "No teammate is available" }
      const first = yield* team.postMessage(input)
      yield* team.archiveRoom(room.id)
      const retry = yield* team.postMessage(input)
      expect(retry.message.id).toBe(first.message.id)
      expect(yield* team.postMessage({ ...input, id: "msg_archived_new" }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
    }),
  )

  it.effect("binds waiting-room history once when a queued task is first claimed", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "history-binding" })
      const first = yield* team.createTeammate({
        roomID: room.id,
        name: "First",
        handle: "first",
        role: "Worker",
        mission: "Work",
      })
      yield* team.createTeammate({
        roomID: room.id,
        name: "Second",
        handle: "second",
        role: "Worker",
        mission: "Work",
      })
      const firstPost = yield* team.postMessage({
        id: "msg_waiting_first",
        roomID: room.id,
        text: "@first handle this",
      })
      yield* team.postMessage({ id: "msg_waiting_second", roomID: room.id, text: "@second another task" })
      const [claimed] = yield* team.claimTasks({ owner: "history-owner", limit: 1, leaseMs: 1000 })
      expect(claimed?.teammateID).toBe(first.id)
      const prompt = (yield* team.getTask(firstPost.tasks[0]!.id)).execution.prompt
      expect(prompt).toContain("You: @second another task")
      yield* Database.Service.use(({ db }) =>
        db.update(TeamTaskTable).set({ lease_expires_at: 0 }).where(eq(TeamTaskTable.id, claimed!.id)).run(),
      )
      yield* team.claimTasks({ owner: "history-owner", limit: 1, leaseMs: 1000 })
      expect((yield* team.getTask(firstPost.tasks[0]!.id)).execution.prompt).toBe(prompt)
    }),
  )

  it.effect("keeps event schedules paused on restore and blocks resume while archived", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const loops = yield* Loop.Service
      const room = yield* team.createRoom({ name: "event-lifecycle" })
      const mate = yield* team.createTeammate({
        roomID: room.id,
        name: "Event worker",
        handle: "eventworker",
        role: "Worker",
        mission: "Handle events",
      })
      const loop = yield* loops.create({
        teammateID: mate.id,
        name: "Event schedule",
        prompt: "Handle event",
        paused: true,
        eventTrigger: { type: "file-change", paths: ["src"] },
      })
      yield* team.archiveRoom(room.id)
      expect((yield* loops.get(loop.id)).status).toBe("paused")
      expect(yield* loops.resume(loop.id).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      yield* team.restoreRoom(room.id)
      expect((yield* loops.get(loop.id)).status).toBe("paused")
    }),
  )

  it.effect("rejects attaching an existing Loop to an archived room", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const loops = yield* Loop.Service
      const existingMate = yield* team.createTeammate({
        name: "Existing owner",
        handle: "existingowner",
        role: "Worker",
        mission: "Run duty",
      })
      const loop = yield* loops.create({
        teammateID: existingMate.id,
        name: "Existing duty",
        prompt: "Run",
        intervalSeconds: 3600,
      })
      const room = yield* team.createRoom({ name: "duty-lifecycle" })
      const mate = yield* team.createTeammate({
        roomID: room.id,
        name: "Duty worker",
        handle: "dutyworker",
        role: "Worker",
        mission: "Run duty",
      })
      yield* team.archiveRoom(room.id)
      expect(yield* team.attachDuty({ teammateID: mate.id, loopID: loop.id }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
      expect((yield* team.teammateForDuty(loop.id))?.id).toBe(existingMate.id)
    }),
  )
})
