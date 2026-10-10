import { describe, expect, test } from "bun:test"
import type { Team } from "@turenlabs/schema/team"
import {
  assignedHandles,
  factoryConfigProblem,
  factoryOutput,
  insertMention,
  mentionMatches,
  mentionToken,
  mentionedHandles,
  mergeMessages,
  parseFactoryParameters,
  replyContext,
  roomCoordinator,
  roomDeleteBlocker,
  roomSchedules,
  selectFactoryTeammate,
  teammateDraft,
} from "@turenlabs/client/team"

const teammate = (handle: string) => ({ handle }) as Team.Teammate
const message = (id: string, seq: number) => ({ id, seq }) as Team.Message

describe("team room rules", () => {
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

  test("accepts only JSON objects for factory parameters", () => {
    expect(parseFactoryParameters('{"count":2,"enabled":true}')).toEqual({ count: 2, enabled: true })
    const message = 'Parameters must be a JSON object, e.g. {"scope":"docs"}'
    expect(() => parseFactoryParameters("[]")).toThrow(message)
    expect(() => parseFactoryParameters("null")).toThrow(message)
    expect(() => parseFactoryParameters("{")).toThrow(message)
  })

  test("bounds selected factory teammates and permits deselection", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `mate-${index}`)
    expect(() => selectFactoryTeammate(ids, "mate-10", true)).toThrow("Select at most 10 teammates")
    expect(selectFactoryTeammate(ids, "mate-0", false)).toHaveLength(9)
    expect(selectFactoryTeammate(ids, "mate-0", true)).toEqual(ids)
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
    expect(roomDeleteBlocker(value, [{ factoryRoomID: null, teammateID: null }])).toBeUndefined()
    expect(
      roomDeleteBlocker({ ...value, teammates: [{ id: "mate" } as Team.Teammate] }, [{ teammateID: "mate" }]),
    ).toContain("schedules")
  })

  test("normalizes a new teammate the way the create form sends it", () => {
    expect(teammateDraft({ name: "  Morgan ", handle: " @moss ", role: "  ", mission: " Review. " })).toEqual({
      name: "Morgan",
      handle: "moss",
      role: "Security teammate",
      mission: " Review. ",
    })
    expect(teammateDraft({ name: "Rae", handle: "rae", role: " Lead ", mission: "" }).role).toBe("Lead")
  })

  test("matches only the token at the caret with a valid mention boundary", () => {
    expect(mentionToken("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(mentionToken("Hello (@Mo", 10)).toEqual({ start: 7, end: 10, query: "Mo" })
    expect(mentionToken("First @rae\n@moss", 16)).toEqual({ start: 11, end: 16, query: "moss" })
    expect(mentionToken("email@moss", 10)).toBeUndefined()
    expect(mentionToken("user_@moss", 10)).toBeUndefined()
    expect(mentionToken("@moss done", 10)).toBeUndefined()
    expect(mentionToken("@123", 4)).toBeUndefined()
    expect(mentionToken("@moss", 0)).toBeUndefined()
    expect(mentionToken("@moss", 5, 2)).toBeUndefined()
    expect(mentionToken("@moss", 6)).toBeUndefined()
  })

  test("inserts at the current caret and keeps all text after the caret", () => {
    const value = "Ask @mo, then @rae"
    const token = mentionToken(value, 7)!
    expect(token).toEqual({ start: 4, end: 7, query: "mo" })
    expect(insertMention(value, token, "moss")).toEqual({ value: "Ask @moss , then @rae", caret: 10 })
    expect(insertMention("@moSuffix", mentionToken("@moSuffix", 3)!, "moss")).toEqual({
      value: "@moss Suffix",
      caret: 6,
    })
  })

  test("supports handle hyphens and underscores without completing old tokens", () => {
    expect(mentionToken("@rae-", 5)?.query).toBe("rae-")
    expect(mentionToken("@rae_one", 8)?.query).toBe("rae_one")
    expect(mentionToken("@moss @", 7)).toEqual({ start: 6, end: 7, query: "" })
    expect(mentionToken(`@${"a".repeat(33)}`, 34)).toBeUndefined()
  })

  test("filters handle, name and role without excluding paused teammates", () => {
    const teammates = [
      { id: "moss", handle: "moss", name: "Morgan", role: "Engineer", status: "active" },
      { id: "rae", handle: "rae-", name: "Rachel", role: "Reviewer", status: "paused" },
    ] as Team.Teammate[]
    expect(mentionMatches(teammates, "MOSS")).toEqual([teammates[0]!])
    expect(mentionMatches(teammates, "mor")).toEqual([teammates[0]!])
    expect(mentionMatches(teammates, "REVIEW")).toEqual([teammates[1]!])
    expect(mentionMatches(teammates, "")).toEqual(teammates)
    expect(mentionMatches(teammates, "unknown")).toEqual([])
  })

  test("reports the first factory configuration problem", () => {
    const config = {
      outcome: "ship",
      constraints: "",
      acceptanceCriteria: "works",
      directory: "/srv/app",
      coordinatorTeammateID: "a",
      teammateIDs: ["a", "b"],
    }
    const mates = [{ id: "a" }, { id: "b" }]
    expect(factoryConfigProblem(config, mates)).toBeUndefined()
    expect(factoryConfigProblem({ ...config, outcome: " " }, mates)).toContain("required")
    expect(factoryConfigProblem({ ...config, coordinatorTeammateID: "c" }, mates)).toContain("coordinator")
    expect(factoryConfigProblem({ ...config, coordinatorTeammateID: "", teammateIDs: [] }, mates)).toContain(
      "coordinator",
    )
    expect(factoryConfigProblem(config, [{ id: "a" }])).toContain("belong to this room")
    expect(factoryConfigProblem({ ...config, outcome: "x".repeat(4001) }, mates)).toContain("Outcome is limited")
    expect(factoryConfigProblem({ ...config, constraints: "x".repeat(8001) }, mates)).toContain("Constraints")
    expect(factoryConfigProblem({ ...config, acceptanceCriteria: "x".repeat(4001) }, mates)).toContain("criteria")
    const many = Array.from({ length: 11 }, (_, index) => `m${index}`)
    expect(
      factoryConfigProblem(
        { ...config, coordinatorTeammateID: "m0", teammateIDs: many },
        many.map((id) => ({ id })),
      ),
    ).toContain("between 1 and 10")
  })

  test("reads complete handles once, lower-cased", () => {
    expect(mentionedHandles("@Moss hi @moss, @rae- and a@b.c")).toEqual(["moss", "rae-"])
  })
})

describe("factory output", () => {
  test("recognises a plan and a check, and nothing else", () => {
    const plan = JSON.stringify({ assignments: [{ teammateID: "tm_moss", prompt: "Reply with ok" }] })
    expect(factoryOutput(plan)).toEqual({ kind: "plan", assignments: [{ teammateID: "tm_moss", prompt: "Reply with ok" }] })
    expect(factoryOutput('{"status":"accepted","summary":"All good"}')).toEqual({
      kind: "check",
      status: "accepted",
      summary: "All good",
    })
    expect(factoryOutput('{"status":"maybe","summary":"x"}')).toBeUndefined()
    expect(factoryOutput("Done, see @rae")).toBeUndefined()
  })

  test("room schedules are those of the room or its teammates", () => {
    const value = { room: { id: "trm_a" }, teammates: [{ id: "tm_1" }] }
    const loops = [{ id: "a", factoryRoomID: "trm_a" }, { id: "b", teammateID: "tm_1" }, { id: "c", teammateID: "tm_9" }]
    expect(roomSchedules(value, loops).map((loop) => loop.id)).toEqual(["a", "b"])
  })
})
