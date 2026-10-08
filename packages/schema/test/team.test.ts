import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Team } from "../src/team"

describe("Team contracts", () => {
  test("normalizes complete mention tokens without matching emails or truncated handles", () => {
    expect(Team.mentionedHandles("@RAE (@rae-) @rae @RAE- email@rae @unknown")).toEqual(["rae", "rae-", "unknown"])
    expect(Team.mentionedHandles(`@${"a".repeat(33)}`)).toEqual([])
    expect(Team.mentionedHandles("@rae-long-")).toEqual(["rae-long-"])
  })

  test("optional execution settings are omitted from encoded teammates", () => {
    expect(
      Schema.encodeSync(Team.CreateTeammate)({
        name: "Moss",
        handle: "moss",
        role: "Application security",
        mission: "Review dependencies and explain risk.",
        directory: undefined,
        agent: undefined,
        model: undefined,
      }),
    ).toEqual({
      name: "Moss",
      handle: "moss",
      role: "Application security",
      mission: "Review dependencies and explain risk.",
    })
  })

  test("public Team schemas have unique domain identifiers", () => {
    const identifiers = [
      Team.Room,
      Team.Teammate,
      Team.Message,
      Team.TaskStatus,
      Team.Task,
      Team.Duty,
      Team.State,
      Team.CreateTeammate,
      Team.EditTeammate,
      Team.PostMessage,
      Team.Posted,
    ].map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers.every((identifier) => typeof identifier === "string" && identifier.startsWith("Team."))).toBe(
      true,
    )
  })

  test("validates bounded factory configuration and stage contracts", () => {
    const config = {
      outcome: "Ship the feature",
      parameters: { version: 1, flags: ["safe", true] },
      constraints: "Keep permissions unchanged",
      acceptanceCriteria: "Tests pass",
      directory: "/repo",
      coordinatorTeammateID: "tm_coordinator",
      teammateIDs: ["tm_coordinator", "tm_worker"],
    }
    expect(Schema.is(Team.FactoryConfig)(config)).toBe(true)
    expect(
      Schema.is(Team.FactoryConfig)({
        ...config,
        teammateIDs: [
          "tm_coordinator",
          "tm_1",
          "tm_2",
          "tm_3",
          "tm_4",
          "tm_5",
          "tm_6",
          "tm_7",
          "tm_8",
          "tm_9",
          "tm_10",
        ],
      }),
    ).toBe(false)
    expect(Schema.is(Team.FactoryPlan)({ assignments: [{ teammateID: "tm_worker", prompt: "Implement" }] })).toBe(true)
    expect(Schema.is(Team.FactoryCheck)({ status: "accepted", summary: "Done" })).toBe(true)
    expect(
      Schema.is(Team.FactoryRun)({
        id: "frun_1",
        roomID: "room_1",
        status: "running",
        phase: "plan",
        taskIDs: [],
        time: { created: 1, updated: 1 },
      }),
    ).toBe(true)
  })
})
