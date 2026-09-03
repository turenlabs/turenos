import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionHistoryQuery, SessionsCursor, SessionTaskCursor, SessionTaskListQuery } from "../src/groups/session"
import { Session } from "@turenlabs/schema/session"
import { SessionTask } from "@turenlabs/schema/session-task"

describe("SessionsCursor", () => {
  test("round trips without Node globals", async () => {
    const input = {
      workspace: undefined,
      search: "protocol",
      order: "desc" as const,
      anchor: { id: Session.ID.make("ses_test"), time: 1, direction: "next" as const },
    }
    const cursor = SessionsCursor.make(input)

    expect(await Effect.runPromise(SessionsCursor.parse(cursor))).toEqual(input)
  })
})

describe("SessionHistoryQuery", () => {
  test("decodes numeric paging inputs", async () => {
    const query = await Effect.runPromise(Schema.decodeUnknownEffect(SessionHistoryQuery)({ after: "3", limit: "10" }))

    expect(query).toEqual({ after: 3, limit: 10 })
  })
})

describe("SessionTaskCursor", () => {
  test("round trips the stable task anchor without Node globals", async () => {
    const input = {
      rootSessionID: Session.ID.make("ses_task_root"),
      timeCreated: 42,
      id: SessionTask.ID.make("tsk_task_anchor"),
    }
    const cursor = SessionTaskCursor.make(input)

    expect(await Effect.runPromise(SessionTaskCursor.parse(cursor))).toEqual(input)
  })

  test("rejects malformed cursors and page sizes above the hard maximum", async () => {
    expect(await Effect.runPromise(Effect.exit(SessionTaskCursor.parse("not-a-cursor")))).toMatchObject({
      _tag: "Failure",
    })
    expect(
      await Effect.runPromise(Schema.decodeUnknownEffect(SessionTaskListQuery)({ limit: "101" }).pipe(Effect.exit)),
    ).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(SessionTaskListQuery)({ limit: "100" }))).toEqual({
      limit: 100,
    })
  })
})
