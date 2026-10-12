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
      Team.Attachment,
      Team.AttachmentInfo,
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

  test("bounds attachment metadata and omits absent metadata", () => {
    const info = { name: "notes.txt", mime: "text/plain", size: 5 }
    expect(Schema.is(Team.AttachmentInfo)(info)).toBe(true)
    for (const size of [-1, 0.5, Team.MAX_ATTACHMENT_BYTES + 1])
      expect(Schema.is(Team.AttachmentInfo)({ ...info, size })).toBe(false)
    const message = {
      id: "msg_meta",
      roomID: "trm_team",
      seq: 1,
      kind: "human" as const,
      author: "You",
      text: "",
      time: 1,
    }
    expect(Schema.encodeSync(Team.Message)({ ...message, attachmentInfo: undefined })).toEqual(message)
    expect(
      Schema.is(Team.Message)({
        ...message,
        attachmentInfo: Array.from({ length: Team.MAX_ATTACHMENTS + 1 }, () => info),
      }),
    ).toBe(false)
    expect(Schema.encodeSync(Team.Message)({ ...message, attachmentInfo: [info] })).toEqual({
      ...message,
      attachmentInfo: [info],
    })
  })

  test("bounds message attachments and omits them when absent", () => {
    const attachment = { name: "notes.txt", mime: "text/plain", uri: "data:text/plain;base64,aGVsbG8=" }
    const post = { id: "msg_1", text: "", attachments: [attachment] }
    expect(Team.Attachment.ast.annotations?.identifier).toBe("Team.Attachment")
    expect(Schema.is(Team.PostMessage)(post)).toBe(true)
    expect(Schema.encodeSync(Team.PostMessage)({ id: "msg_1", text: "Hello", attachments: undefined })).toEqual({
      id: "msg_1",
      text: "Hello",
    })
    expect(
      Schema.is(Team.PostMessage)({
        ...post,
        attachments: Array.from({ length: Team.MAX_ATTACHMENTS + 1 }, () => attachment),
      }),
    ).toBe(false)
    expect(Schema.is(Team.PostMessage)({ ...post, attachments: [{ ...attachment, name: "" }] })).toBe(false)
    expect(Schema.is(Team.PostMessage)({ ...post, attachments: [{ ...attachment, name: "n".repeat(256) }] })).toBe(
      false,
    )
    expect(Schema.is(Team.PostMessage)({ ...post, attachments: [{ ...attachment, mime: "m".repeat(256) }] })).toBe(
      false,
    )
    expect(
      Schema.is(Team.PostMessage)({ ...post, attachments: [{ ...attachment, uri: "https://example.com/a.txt" }] }),
    ).toBe(false)
    expect(Schema.is(Team.PostMessage)({ ...post, attachments: [{ ...attachment, uri: "file:///etc/passwd" }] })).toBe(
      false,
    )
    expect(
      Schema.is(Team.PostMessage)({
        ...post,
        attachments: [
          {
            name: "big.bin",
            mime: "application/octet-stream",
            uri: `data:application/octet-stream;base64,${"A".repeat(Math.ceil(Team.MAX_ATTACHMENT_BYTES / 3) * 4 + 256)}`,
          },
        ],
      }),
    ).toBe(false)
    expect(
      Schema.is(Team.Message)({
        id: "msg_1",
        roomID: "trm_team",
        seq: 1,
        kind: "human",
        author: "You",
        text: "",
        attachments: [attachment],
        time: 1,
      }),
    ).toBe(true)
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
