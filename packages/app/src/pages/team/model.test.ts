import { describe, expect, test } from "bun:test"
import type { Team } from "@turenlabs/schema/team"
import { ownsTeamResponse, pendingFactoryOperation, pendingMessage, roomActivity, timeLabel } from "./model"

const teammate = (handle: string) => ({ handle }) as Team.Teammate

describe("team room model", () => {
  test("shows room activity through queued, starting, and running tasks", () => {
    const mate = { ...teammate("moss"), id: "mate-moss", name: "Moss" }
    const task = { id: "task", roomID: "room", teammateID: mate.id, status: "queued" } as Team.Task
    expect(roomActivity("room", [task], [mate])).toBe("Moss is getting ready...")
    expect(roomActivity("room", [{ ...task, status: "claimed" }], [mate])).toBe("Moss is getting ready...")
    expect(roomActivity("room", [{ ...task, status: "running" }], [mate])).toBe("Moss is working...")
    for (const status of ["succeeded", "failed", "cancelled", "stale"] as const)
      expect(roomActivity("room", [{ ...task, status }], [mate])).toBeUndefined()
    expect(roomActivity("other-room", [task], [mate])).toBeUndefined()
    expect(roomActivity("room", [], [mate])).toBeUndefined()
  })

  test("deduplicates teammates and keeps multi-agent activity compact", () => {
    const mates = ["Moss", "Iris", "Rae"].map((name) => ({ ...teammate(name), id: name, name }))
    const tasks = mates.map((mate) => ({ roomID: "room", teammateID: mate.id, status: "running" }) as Team.Task)
    expect(roomActivity("room", [tasks[0]!, tasks[0]!], mates)).toBe("Moss is working...")
    expect(roomActivity("room", tasks.slice(0, 2), mates)).toBe("Moss and Iris are working...")
    expect(roomActivity("room", tasks, mates)).toBe("Moss, Iris and 1 more are working...")
    expect(roomActivity("room", [tasks[0]!], [])).toBe("A teammate is working...")
  })

  test("keeps an exact message retry target if the selected room changes", () => {
    const client = {}
    const pending = { id: "message-id", roomID: "room-a", text: "original", client, generation: 1 }
    expect(
      pendingMessage(pending, { roomID: "room-b", text: "edited", client: {}, generation: 2 }, () => "new-id"),
    ).toBe(pending)
  })

  test("owns a successful exact retry after room A to B to A navigation", () => {
    const client = {}
    const pending = pendingMessage(
      undefined,
      { roomID: "room-a", text: "original", client, generation: 1 },
      () => "message-id",
    )
    expect(ownsTeamResponse({ client: pending.client, roomID: pending.roomID }, { client, roomID: "room-b" })).toBe(
      false,
    )
    const retried = pendingMessage(
      pending,
      { roomID: "room-a", text: "original", client, generation: 3 },
      () => "new-id",
    )
    expect(retried).toBe(pending)
    expect(retried.id).toBe("message-id")
    expect(ownsTeamResponse({ client: retried.client, roomID: retried.roomID }, { client, roomID: "room-a" })).toBe(
      true,
    )
  })

  test("rejects old-server success even when both servers use the default room ID", () => {
    const client = {}
    const pending = { id: "message-id", roomID: "trm_team", text: "original", client, generation: 1 }
    const current = { roomID: "trm_team", text: "original", client: {}, generation: 2 }
    expect(pendingMessage(pending, current, () => "new-id")).toBe(pending)
    expect(
      ownsTeamResponse(
        { client: pending.client, roomID: pending.roomID },
        { client: current.client, roomID: current.roomID },
      ),
    ).toBe(false)
  })

  test("rejects a delayed catalogue after a server change or a newer generation", async () => {
    const client = {}
    const owner = { client, generation: 1 }
    let current = owner
    let agents = ["old"]
    const delayed = Promise.withResolvers<string[]>()
    const response = delayed.promise.then((result) => {
      if (ownsTeamResponse(owner, current)) agents = result
    })
    current = { client: {}, generation: 2 }
    agents = ["new-server"]
    delayed.resolve(["stale-server"])
    await response
    expect(agents).toEqual(["new-server"])
    expect(ownsTeamResponse(owner, { client, generation: 2 })).toBe(false)
    expect(ownsTeamResponse(owner, owner)).toBe(true)
  })

  test("keeps a factory operation ID for an exact request retry", () => {
    const client = {}
    const pending = pendingFactoryOperation(undefined, { roomID: "room-a", client, generation: 1 }, () => "run-id")
    const retry = pendingFactoryOperation(pending, { roomID: "room-a", client, generation: 1 }, () => "new-id")
    expect(retry).toBe(pending)
    expect(retry.id).toBe("run-id")
    expect(ownsTeamResponse(retry, { roomID: "room-b", client, generation: 2 })).toBe(false)
  })

  test("formats IRC timestamps as compact 24-hour HH:mm", () => {
    expect(timeLabel(Date.now())).toMatch(/^\d{2}:\d{2}$/)
  })

  test("rejects delayed room mutation responses after navigation or a server change", async () => {
    const client = {}
    const owner = { client, roomID: "room-a", generation: 1 }
    let current = owner
    let applied = false
    const delayed = Promise.withResolvers<void>()
    const response = delayed.promise.then(() => {
      if (ownsTeamResponse(owner, current)) applied = true
    })
    current = { client, roomID: "room-a", generation: 3 }
    delayed.resolve()
    await response
    expect(applied).toBe(false)
    expect(ownsTeamResponse(owner, { ...owner, roomID: "room-b" })).toBe(false)
    expect(ownsTeamResponse(owner, { ...owner, client: {} })).toBe(false)
  })
})
