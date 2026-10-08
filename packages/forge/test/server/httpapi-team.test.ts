import { afterEach, describe, expect, test } from "bun:test"
import { Context, Schema } from "effect"
import { Team } from "@turenlabs/schema/team"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, method = "GET", body?: unknown) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      method,
      headers: { "x-forge-directory": directory, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Team HttpApi", () => {
  test("edits, archives, restores, and deletes an idle room", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/api/team/room", tmp.path, "POST", { name: "room-lifecycle" })
    expect(created.status).toBe(200)
    const room = Schema.decodeUnknownSync(Team.Room)(await created.json())
    const route = `/api/team/room/${room.id}`
    const edited = await request(route, tmp.path, "PATCH", { name: "renamed-room", topic: "Shared notes" })
    expect(edited.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Room)(await edited.json())).toMatchObject({
      id: room.id,
      name: "renamed-room",
      topic: "Shared notes",
      archived: false,
    })
    const payload = { id: "tmsg_room_lifecycle", roomID: room.id, text: "A shared note" }
    const posted = await request("/api/team/message", tmp.path, "POST", payload)
    expect(posted.status).toBe(200)
    const initial = Schema.decodeUnknownSync(Team.Posted)(await posted.json())
    expect((await request(route, tmp.path, "DELETE")).status).toBe(409)
    const teammateResponse = await request("/api/team/teammate", tmp.path, "POST", {
      roomID: room.id,
      name: "Room member",
      handle: "roommember",
      role: "Analyst",
      mission: "Review notes",
      directory: tmp.path,
    })
    expect(teammateResponse.status).toBe(200)
    const teammate = Schema.decodeUnknownSync(Team.Teammate)(await teammateResponse.json())
    const archived = await request(`${route}/archive`, tmp.path, "POST")
    expect(archived.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Room)(await archived.json()).archived).toBe(true)
    expect((await request(route, tmp.path, "PATCH", { topic: "Not allowed" })).status).toBe(409)
    expect(
      (await request(`/api/team/teammate/${teammate.id}`, tmp.path, "PATCH", { mission: "Not allowed" })).status,
    ).toBe(409)
    const duty = await request("/api/loop", tmp.path, "POST", {
      teammateID: teammate.id,
      name: "Archived duty",
      prompt: "Do not run",
      intervalSeconds: 3600,
      paused: true,
    })
    expect([400, 409]).toContain(duty.status)
    expect((await request("/api/team/message", tmp.path, "POST", { ...payload, id: "tmsg_archived_new" })).status).toBe(
      409,
    )
    const retried = await request("/api/team/message", tmp.path, "POST", payload)
    expect(retried.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Posted)(await retried.json())).toEqual(initial)
    const restored = await request(`${route}/restore`, tmp.path, "POST")
    expect(restored.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Room)(await restored.json()).archived).toBe(false)
    expect((await request(`${route}/archive`, tmp.path, "POST")).status).toBe(200)
    expect((await request(route, tmp.path, "DELETE")).status).toBe(204)
    const state = Schema.decodeUnknownSync(Team.State)(await (await request("/api/team", tmp.path)).json())
    expect(state.rooms.some((item) => item.id === room.id)).toBe(false)
    expect((await request("/api/team/room/trm_team", tmp.path, "DELETE")).status).toBe(409)
  })

  test("routes ordinary messages to one coordinator and keeps mentions direct", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/api/team/room", tmp.path, "POST", { name: "http-routing-room" })
    expect(created.status).toBe(200)
    const room = Schema.decodeUnknownSync(Team.Room)(await created.json())
    const mates: Team.Teammate[] = []
    for (const handle of ["coordinator", "researcher"]) {
      const response = await request("/api/team/teammate", tmp.path, "POST", {
        roomID: room.id,
        name: handle,
        handle,
        role: "Teammate",
        mission: "Reply to team messages.",
        directory: tmp.path,
      })
      expect(response.status).toBe(200)
      mates.push(Schema.decodeUnknownSync(Team.Teammate)(await response.json()))
    }
    const message = await request("/api/team/message", tmp.path, "POST", {
      id: "tmsg_hello_team",
      roomID: room.id,
      text: "Hey team",
    })
    expect(message.status).toBe(200)
    const ordinary = Schema.decodeUnknownSync(Team.Posted)(await message.json())
    expect(ordinary.tasks).toMatchObject([{ teammateID: mates[0]!.id }])
    const directed = await request("/api/team/message", tmp.path, "POST", {
      id: "tmsg_direct_team",
      roomID: room.id,
      text: "@researcher review this",
    })
    expect(directed.status).toBe(200)
    const assignment = Schema.decodeUnknownSync(Team.Posted)(await directed.json())
    expect(assignment.tasks).toMatchObject([{ teammateID: mates[1]!.id }])
    const unknown = await request("/api/team/message", tmp.path, "POST", {
      id: "tmsg_unknown_team",
      roomID: room.id,
      text: "@missing review this",
    })
    expect(unknown.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Posted)(await unknown.json()).tasks).toHaveLength(0)
    expect((await request(`/api/team/room/${room.id}/archive`, tmp.path, "POST")).status).toBe(409)
    for (const task of [...ordinary.tasks, ...assignment.tasks])
      expect((await request(`/api/team/task/${task.id}/cancel`, tmp.path, "POST")).status).toBe(200)
  })

  test("creates duties directly for a teammate without extra legacy members", async () => {
    await using tmp = await tmpdir({ git: true })
    const roomResponse = await request("/api/team/room", tmp.path, "POST", { name: "atomic-duties" })
    expect(roomResponse.status).toBe(200)
    const room = Schema.decodeUnknownSync(Team.Room)(await roomResponse.json())
    const response = await request("/api/team/teammate", tmp.path, "POST", {
      roomID: room.id,
      name: "Moss",
      handle: "moss",
      role: "Analyst",
      mission: "Review evidence.",
      directory: tmp.path,
    })
    expect(response.status).toBe(200)
    const teammate = Schema.decodeUnknownSync(Team.Teammate)(await response.json())
    for (const name of ["Dependency review", "Change review"]) {
      expect(
        (
          await request("/api/loop", tmp.path, "POST", {
            teammateID: teammate.id,
            name,
            prompt: "Review evidence.",
            intervalSeconds: 3600,
            paused: true,
          })
        ).status,
      ).toBe(200)
    }
    const state = Schema.decodeUnknownSync(Team.State)(
      await (await request(`/api/team?roomID=${room.id}`, tmp.path)).json(),
    )
    expect(state.teammates).toHaveLength(1)
    expect(state.duties).toHaveLength(2)
    expect(state.duties.every((duty) => duty.teammateID === teammate.id)).toBe(true)
    expect(
      (
        await request("/api/loop", tmp.path, "POST", {
          teammateID: "missing",
          name: "Invalid",
          prompt: "Review",
          intervalSeconds: 3600,
          paused: true,
        })
      ).status,
    ).toBe(400)
  })

  test("stores room messages globally and reconciles exact retries", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const payload = { id: "tmsg_httpapi_retry", text: "Morning, team." }
    const posted = await request("/api/team/message", first.path, "POST", payload)
    expect(posted.status).toBe(200)
    const initial = Schema.decodeUnknownSync(Team.Posted)(await posted.json())
    expect(initial.tasks).toHaveLength(0)
    const retried = await request("/api/team/message", second.path, "POST", payload)
    expect(retried.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Posted)(await retried.json())).toEqual(initial)
    const response = await request("/api/team", second.path)
    expect(response.status).toBe(200)
    const state = Schema.decodeUnknownSync(Team.State)(await response.json())
    expect(state.messages.filter((message) => message.id === payload.id)).toHaveLength(1)
    const conflict = await request("/api/team/message", first.path, "POST", { ...payload, text: "Different task" })
    expect(conflict.status).toBe(409)
  })

  test("creates teammates in another room and stops work without changing their lifecycle", async () => {
    await using tmp = await tmpdir({ git: true })
    const roomResponse = await request("/api/team/room", tmp.path, "POST", {
      name: "research",
      topic: "Security references",
    })
    expect(roomResponse.status).toBe(200)
    const room = Schema.decodeUnknownSync(Team.Room)(await roomResponse.json())
    const teammateResponse = await request("/api/team/teammate", tmp.path, "POST", {
      roomID: room.id,
      name: "Echo",
      handle: "echo",
      role: "Security researcher",
      mission: "Collect evidence and explain findings.",
      directory: tmp.path,
    })
    expect(teammateResponse.status).toBe(200)
    const teammate = Schema.decodeUnknownSync(Team.Teammate)(await teammateResponse.json())
    expect((await request(`/api/team/teammate/${teammate.id}/stop`, tmp.path, "POST")).status).toBe(204)
    const state = Schema.decodeUnknownSync(Team.State)(
      await (await request(`/api/team?roomID=${room.id}`, tmp.path)).json(),
    )
    expect(state.teammates).toMatchObject([{ id: teammate.id, status: "active" }])
    expect((await request("/api/team/teammate/missing/stop", tmp.path, "POST")).status).toBe(400)
  })

  test("rejects invalid handles, blank messages, and conflicting history cursors", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(
      (
        await request("/api/team/teammate", tmp.path, "POST", {
          name: "Invalid",
          handle: "not a handle",
          role: "Security",
          mission: "Review evidence.",
        })
      ).status,
    ).toBe(400)
    expect((await request("/api/team/message", tmp.path, "POST", { id: "tmsg_empty", text: "  " })).status).toBe(400)
    expect((await request("/api/team?after=1&before=2", tmp.path)).status).toBe(400)
  })

  test("preserves existing duties and assigns several duties to one teammate", async () => {
    await using tmp = await tmpdir({ git: true })
    const loopIDs: string[] = []
    for (const name of ["Dependency review", "Code review"]) {
      const response = await request("/api/loop", tmp.path, "POST", {
        name,
        prompt: `Complete ${name}`,
        location: { directory: tmp.path },
        intervalSeconds: 60,
        paused: true,
      })
      expect(response.status).toBe(200)
      loopIDs.push(((await response.json()) as { id: string }).id)
    }
    const migrated = Schema.decodeUnknownSync(Team.State)(await (await request("/api/team", tmp.path)).json())
    expect(migrated.duties.map((duty) => duty.loopID).toSorted()).toEqual(loopIDs.toSorted())
    expect(migrated.teammates).toHaveLength(2)
    expect(migrated.teammates.every((teammate) => teammate.status === "paused")).toBe(true)
    const target = migrated.teammates[0]!
    for (const loopID of loopIDs) {
      expect((await request(`/api/team/teammate/${target.id}/duty`, tmp.path, "POST", { loopID })).status).toBe(200)
      const response = await request(`/api/loop/${loopID}`, tmp.path)
      expect(response.status).toBe(200)
      expect((await response.json()) as { id: string; status: string }).toMatchObject({ id: loopID, status: "paused" })
    }
    const assigned = Schema.decodeUnknownSync(Team.State)(await (await request("/api/team", tmp.path)).json())
    expect(assigned.duties.filter((duty) => duty.teammateID === target.id)).toHaveLength(2)
  })

  test("paused teammate mentions remain room messages without starting work", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/team/teammate", tmp.path, "POST", {
      name: "Moss",
      handle: "moss",
      role: "AppSec",
      mission: "Review dependencies.",
      directory: tmp.path,
    })
    expect(response.status).toBe(200)
    const teammate = Schema.decodeUnknownSync(Team.Teammate)(await response.json())
    expect((await request(`/api/team/teammate/${teammate.id}`, tmp.path, "PATCH", { status: "paused" })).status).toBe(
      200,
    )
    const posted = await request("/api/team/message", tmp.path, "POST", {
      id: "tmsg_paused",
      text: "@moss review this change",
    })
    expect(posted.status).toBe(200)
    expect(Schema.decodeUnknownSync(Team.Posted)(await posted.json()).tasks).toHaveLength(0)
    const state = Schema.decodeUnknownSync(Team.State)(await (await request("/api/team", tmp.path)).json())
    expect(state.messages.some((message) => message.kind === "system" && message.text.includes("@moss"))).toBe(true)
  })
})
