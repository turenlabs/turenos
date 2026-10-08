import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Team } from "@turenlabs/schema/team"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamMessageTable, TeamTaskTable, TeamTeammateTable } from "@turenlabs/core/team/workspace.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, TeamWorkspace.node])))
const avatar = Array.from({ length: 8 }, () => ".0123456")

describe("Team rich output storage", () => {
  it.effect("round-trips avatars and keeps legacy avatars absent", () => Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const legacy = yield* team.createTeammate({ name: "Legacy", handle: "legacy", role: "Review", mission: "Review" })
    expect(legacy.avatar).toBeUndefined()
    expect((yield* team.getTeammate(legacy.id)).avatar).toBeUndefined()
    const mate = yield* team.createTeammate({ name: "Pixels", handle: "pixels", role: "Review", mission: "Review", avatar })
    expect(mate.avatar).toEqual(avatar)
    expect((yield* db.select().from(TeamTeammateTable).where(eq(TeamTeammateTable.id, mate.id)).get())?.avatar).toEqual(avatar)
    const edited = Array.from({ length: 8 }, () => "77777777")
    expect((yield* team.editTeammate({ id: mate.id, avatar: edited })).avatar).toEqual(edited)
    yield* team.editTeammate({ id: mate.id, role: "Builder" })
    expect((yield* team.getTeammate(mate.id)).avatar).toEqual(edited)
    expect((yield* team.state()).teammates.find((row) => row.id === mate.id)?.avatar).toEqual(edited)
  }))

  it.effect("rejects invalid avatars before create or edit writes", () => Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const mate = yield* team.createTeammate({ name: "Pixels", handle: "pixels", role: "Review", mission: "Review", avatar })
    for (const invalid of [avatar.slice(1), [...avatar, "........"], Array(8).fill("......."), Array(8).fill("88888888"), Array(8).fill("........\n"), null]) {
      expect(yield* team.createTeammate({ name: "Bad", handle: "bad", role: "Review", mission: "Review", avatar: invalid as Team.Avatar }).pipe(Effect.flip)).toBeInstanceOf(Team.InvalidRequestError)
      expect(yield* team.editTeammate({ id: mate.id, avatar: invalid as Team.Avatar }).pipe(Effect.flip)).toBeInstanceOf(Team.InvalidRequestError)
    }
    expect((yield* team.getTeammate(mate.id)).avatar).toEqual(avatar)
    expect((yield* team.state()).teammates).toHaveLength(1)
  }))

  it.effect("persists source IDs once and retains the legacy text fallback", () => Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    yield* team.createTeammate({ name: "Writer", handle: "writer", role: "Writer", mission: "Write" })
    yield* team.postMessage({ id: "msg_rich", text: "@writer Write" })
    const [task] = yield* team.claimTasks({ owner: "worker" })
    yield* team.startTask({ id: task!.id, owner: "worker" })
    const sourceMessageIDs = ["msg_assistant_earlier", "msg_assistant_final"]
    expect(yield* team.finishTask({ id: task!.id, owner: "other", status: "succeeded", text: "Wrong", sourceMessageIDs }).pipe(Effect.flip)).toBeInstanceOf(Team.ConflictError)
    expect(yield* team.finishTask({ id: task!.id, owner: "worker", status: "succeeded", sourceMessageIDs: Array(257).fill("msg_output") }).pipe(Effect.flip)).toBeInstanceOf(Team.InvalidRequestError)
    expect((yield* team.getTask(task!.id)).status).toBe("running")
    yield* team.finishTask({ id: task!.id, owner: "worker", status: "succeeded", text: "Final text", sourceMessageIDs })
    yield* team.finishTask({ id: task!.id, owner: "worker", status: "succeeded", text: "Do not replay", sourceMessageIDs: ["msg_changed"] })
    const result = (yield* team.state()).messages.filter((message) => message.replyTo === "msg_rich")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ text: "Final text", sessionID: task!.sessionID, sourceMessageIDs })
    expect((yield* db.select().from(TeamMessageTable).where(eq(TeamMessageTable.id, result[0]!.id)).get())?.source_message_ids).toEqual(sourceMessageIDs)
    yield* team.postMessage({ id: "msg_legacy", text: "@writer Legacy" })
    const [legacy] = yield* team.claimTasks({ owner: "worker" })
    yield* team.startTask({ id: legacy!.id, owner: "worker" })
    yield* team.finishTask({ id: legacy!.id, owner: "worker", status: "succeeded", text: "Legacy text" })
    expect((yield* team.state()).messages.find((message) => message.replyTo === "msg_legacy")).toMatchObject({ text: "Legacy text", sessionID: legacy!.sessionID })
    expect((yield* team.state()).messages.find((message) => message.replyTo === "msg_legacy")?.sourceMessageIDs).toBeUndefined()
  }))

  it.effect("does not publish source IDs after the task becomes stale", () => Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    yield* team.createTeammate({ name: "Writer", handle: "writer", role: "Writer", mission: "Write" })
    yield* team.postMessage({ id: "msg_stale", text: "@writer Write" })
    const [task] = yield* team.claimTasks({ owner: "worker" })
    yield* team.startTask({ id: task!.id, owner: "worker" })
    yield* db.update(TeamTaskTable).set({ lease_expires_at: 0 }).where(eq(TeamTaskTable.id, task!.id)).run()
    yield* team.claimTasks({ owner: "recovery" })
    expect((yield* team.finishTask({ id: task!.id, owner: "worker", status: "succeeded", text: "Late", sourceMessageIDs: ["msg_late"] })).status).toBe("stale")
    expect((yield* team.state()).messages.some((message) => message.replyTo === "msg_stale")).toBe(false)
  }))
})
