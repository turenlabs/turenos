import { describe, expect, test } from "bun:test"
import {
  assignedHandles,
  roomActivity,
  mergeMessages,
  replyContext,
  ownsTeamResponse,
  parseFactoryParameters,
  pendingFactoryOperation,
  pendingMessage,
  selectFactoryTeammate,
  timeLabel,
  roomCoordinator,
  roomDeleteBlocker,
} from "./model"
import type { Team } from "@turenlabs/schema/team"

const teammate = (handle: string) => ({ handle }) as Team.Teammate
const message = (id: string, seq: number) => ({ id, seq }) as Team.Message

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

  test("resolves reply context only from loaded messages", () => {
    const source = { ...message("source", 1), author: "moss", text: "Check\n  the result" }
    const reply = { ...message("reply", 2), replyTo: source.id }
    expect(replyContext(reply, [source, reply])).toEqual({ author: "moss", excerpt: "Check the result" })
    expect(replyContext(reply, [reply])).toBeUndefined()
    expect(replyContext(message("plain", 3), [source])).toBeUndefined()
  })

  test("caps reply excerpts at 160 characters and keeps markup as plain text", () => {
    const source = { ...message("source", 1), author: "<b>moss</b>", text: "<script>unsafe()</script>" }
    const reply = { ...message("reply", 2), replyTo: source.id }
    expect(replyContext(reply, [source])).toEqual({ author: source.author, excerpt: source.text })
    expect(replyContext(reply, [{ ...source, text: "a".repeat(160) }])?.excerpt).toBe("a".repeat(160))
    expect(replyContext(reply, [{ ...source, text: "a".repeat(161) }])?.excerpt).toBe(`${"a".repeat(159)}…`)
  })

  test("merges retries and orders history without dropping older pages", () => {
    expect(
      mergeMessages([message("later", 3), message("old", 1)], [message("later", 3), message("middle", 2)]).map(
        (item) => item.id,
      ),
    ).toEqual(["old", "middle", "later"])
  })

  test("only resolves explicit handles that belong to room teammates", () => {
    expect(assignedHandles("hello @moss and @unknown, not email@iris", [teammate("moss"), teammate("iris")])).toEqual([
      "moss",
    ])
  })

  test("normalizes uppercase mentions and preserves exact trailing-hyphen handles", () => {
    expect(
      assignedHandles("@RAE-, @RAE! (@MOSS) @unknown @rae-extra", [
        teammate("rae"),
        teammate("rae-"),
        teammate("MOSS"),
      ]),
    ).toEqual(["rae-", "rae", "moss"])
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

  test("accepts only JSON objects for factory parameters", () => {
    expect(parseFactoryParameters('{"count":2,"enabled":true}')).toEqual({ count: 2, enabled: true })
    expect(() => parseFactoryParameters("[]")).toThrow("Parameters must be a JSON object")
    expect(() => parseFactoryParameters("null")).toThrow("Parameters must be a JSON object")
    expect(() => parseFactoryParameters("{")).toThrow()
  })

  test("bounds selected factory teammates and permits deselection", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `mate-${index}`)
    expect(() => selectFactoryTeammate(ids, "mate-10", true)).toThrow("Select at most 10 teammates")
    expect(selectFactoryTeammate(ids, "mate-0", false)).toHaveLength(9)
    expect(selectFactoryTeammate(ids, "mate-0", true)).toEqual(ids)
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

  test("selects the first active coordinator by creation time and ID", () => {
    const mates = [
      { id: "z", status: "active", time: { created: 2 } },
      { id: "b", status: "active", time: { created: 1 } },
      { id: "a", status: "active", time: { created: 1 } },
      { id: "paused", status: "paused", time: { created: 0 } },
    ] as Team.Teammate[]
    expect(roomCoordinator({} as Team.Room, mates)?.id).toBe("a")
    expect(mates[0]?.id).toBe("z")
    const configured = { factory: { config: { coordinatorTeammateID: "paused" } } } as Team.Room
    expect(roomCoordinator(configured, mates)?.id).toBe("paused")
    expect(
      roomCoordinator(
        configured,
        mates.filter((mate) => mate.id !== "paused"),
      ),
    ).toBeUndefined()
  })

  test("blocks room deletion until archive, idle work, and no linked schedules or duties", () => {
    const value = {
      room: { id: "room-a", archived: true },
      tasks: [],
      duties: [],
      factoryRuns: [],
      teammates: [],
    } as unknown as Team.State
    expect(roomDeleteBlocker(value, [])).toBeUndefined()
    expect(roomDeleteBlocker({ ...value, room: { ...value.room, id: "trm_team" } }, [])).toContain("default")
    expect(roomDeleteBlocker({ ...value, room: { ...value.room, archived: false } }, [])).toContain("Archive")
    expect(roomDeleteBlocker({ ...value, tasks: [{ status: "queued" } as Team.Task] }, [])).toContain("active work")
    expect(roomDeleteBlocker({ ...value, factoryRuns: [{ status: "running" } as Team.FactoryRun] }, [])).toContain(
      "active work",
    )
    expect(roomDeleteBlocker({ ...value, duties: [{ loopID: "duty", teammateID: "mate" }] }, [])).toContain("duties")
    expect(roomDeleteBlocker(value, [{ factoryRoomID: "room-a" }])).toContain("schedules")
    expect(roomDeleteBlocker(value, [{ factoryRoomID: "room-b" }])).toBeUndefined()
    expect(
      roomDeleteBlocker({ ...value, teammates: [{ id: "mate" } as Team.Teammate] }, [{ teammateID: "mate" }]),
    ).toContain("schedules")
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
