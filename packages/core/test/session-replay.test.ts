import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventSequenceTable, EventTable } from "@turenlabs/core/event/sql"
import { AgentV2 } from "@turenlabs/core/agent"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionReplay } from "@turenlabs/core/session/replay"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionTask } from "@turenlabs/schema/session-task"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionTaskTable } from "@turenlabs/core/session/task.sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTable } from "@turenlabs/core/session/sql"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("SessionReplay DSL", () => {
  it.effect("parses text, quoted values, negation, and relative times", () =>
    Effect.sync(() => {
      expect(
        SessionReplay.parse('database tool:bash -status:failed path:"session runner" after:24h', 1_000_000_000),
      ).toEqual({
        text: ["database"],
        filters: [
          { field: "tool", value: "bash", negated: false },
          { field: "status", value: "failed", negated: true },
          { field: "path", value: "session runner", negated: false },
          { field: "after", value: "24h", negated: false },
        ],
      })
    }),
  )

  it.effect("rejects unknown fields and malformed values", () =>
    Effect.sync(() => {
      expect(() => SessionReplay.parse("wat:value")).toThrow("Unknown replay filter")
      expect(() => SessionReplay.parse("after:eventually")).toThrow("Invalid replay time")
      expect(() => SessionReplay.parse('tool:"bash')).toThrow("Unterminated quote")
    }),
  )
})

describe("SessionReplay index", () => {
  it.effect("initializes instantly and resumes bounded newest-first batches", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const db = Database.primary((yield* Database.Service).db)
      const first = yield* session.create({ location })
      yield* session.create({ location })
      const newest = yield* session.create({ location })

      yield* db.run(sql.raw("CREATE TABLE session_replay (marker text NOT NULL)"))
      yield* db.run(sql.raw("INSERT INTO session_replay (marker) VALUES ('legacy-index')"))
      yield* SessionReplay.ensure(db)
      expect(
        (yield* db.get<{ count: number }>(sql.raw("SELECT count(*) AS count FROM session_replay_pending_v3")))?.count,
      ).toBe(0)
      yield* SessionReplay.enable(db)
      expect((yield* db.get<{ marker: string }>(sql.raw("SELECT marker FROM session_replay")))?.marker).toBe(
        "legacy-index",
      )
      yield* SessionReplay.backfillBatch(db)
      yield* SessionReplay.backfillBatch(db)
      yield* SessionReplay.backfillBatch(db)
      expect(
        yield* db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE name = 'session_replay'`),
      ).toBeUndefined()
      yield* db.run(sql.raw("DELETE FROM session_replay_v3"))
      yield* db.run(sql.raw("DELETE FROM session_replay_pending_v3"))
      yield* db.run(
        sql.raw(`UPDATE session_replay_meta
        SET value = (SELECT coalesce(max(rowid) + 1, 1) FROM session)
        WHERE key = 'session_before'`),
      )
      yield* db.run(
        sql.raw(`UPDATE session_replay_meta
        SET value = (SELECT coalesce(max(rowid), 0) FROM session)
        WHERE key = 'session_max'`),
      )
      yield* db.run(
        sql.raw(`UPDATE session_replay_meta
        SET value = (SELECT coalesce(max(rowid) + 1, 1) FROM event)
        WHERE key = 'event_before'`),
      )
      yield* db.run(
        sql.raw(`UPDATE session_replay_meta
        SET value = (SELECT coalesce(max(rowid), 0) FROM event)
        WHERE key = 'event_max'`),
      )
      expect(
        (yield* db.get<{ count: number }>(sql.raw("SELECT count(*) AS count FROM session_replay_v3")))?.count,
      ).toBe(0)
      expect(yield* SessionReplay.status(db)).toMatchObject({ status: "indexing", progress: 0 })

      const batch = yield* SessionReplay.backfillBatch(db, { sessions: 1, events: 1 })
      expect(batch).toMatchObject({ complete: false, processed: 2 })
      expect(
        yield* db.get<{ session_id: string }>(
          sql.raw("SELECT session_id FROM session_replay_v3 WHERE kind = 'event' ORDER BY id LIMIT 1"),
        ),
      ).toMatchObject({ session_id: newest.id })

      yield* SessionReplay.ensure(db)
      expect(
        (yield* db.get<{ count: number }>(sql.raw("SELECT count(*) AS count FROM session_replay_v3")))?.count,
      ).toBe(2)
      yield* SessionReplay.backfillBatch(db, { sessions: 1, events: 1 })
      yield* SessionReplay.backfillBatch(db, { sessions: 1, events: 1 })
      expect(yield* SessionReplay.status(db)).toMatchObject({ status: "ready", progress: 1 })

      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID: first.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:00.000Z")),
        messageID: SessionMessage.ID.create(),
        text: `${"😀".repeat(3_000)}TAIL_MARKER`,
      })
      expect(
        (yield* db.get<{ count: number }>(sql.raw("SELECT count(*) AS count FROM session_replay_pending_v3")))?.count,
      ).toBeGreaterThan(0)
      expect(
        (yield* db.get<{ count: number }>(
          sql.raw(
            "SELECT count(*) AS count FROM session_replay_v3 WHERE event_type LIKE 'session.next.context.updated.%'",
          ),
        ))?.count,
      ).toBe(0)
      yield* SessionReplay.backfillBatch(db)
      const indexed = yield* db.get<{ bytes: number; content: string }>(
        sql.raw(`SELECT length(CAST(content AS BLOB)) AS bytes, content FROM session_replay_v3
          WHERE event_type LIKE 'session.next.context.updated.%'`),
      )
      expect(indexed?.bytes).toBeLessThan(8_300)
      expect(indexed?.content).toContain("TAIL_MARKER")
      yield* db
        .update(SessionTable)
        .set({ title: "😀".repeat(3_000) })
        .where(eq(SessionTable.id, first.id))
        .run()
        .pipe(Effect.orDie)
      yield* db.run(sql`UPDATE session SET path = ${"😀".repeat(3_000)} WHERE id = ${first.id}`)
      yield* SessionReplay.backfillBatch(db)
      const bounded = yield* db.get<{ content_bytes: number; path_bytes: number }>(
        sql`SELECT length(CAST(content AS BLOB)) AS content_bytes, length(CAST(paths AS BLOB)) AS path_bytes
            FROM session_replay_v3 WHERE entry_id = ${`session:${first.id}`}`,
      )
      expect(bounded?.content_bytes).toBeLessThan(8_300)
      expect(bounded?.path_bytes).toBeLessThan(4_200)
    }),
  )

  it.effect("backfills metadata and indexes newly committed durable events", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })
      const created = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T11:59:59.000Z")),
        assistantMessageID,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:00.000Z")),
        assistantMessageID,
        callID: "call_replay",
        tool: "bash",
        input: { command: "bun typecheck" },
        provider: { executed: false },
      })
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T10:00:00.000Z")),
        messageID: SessionMessage.ID.create(),
        text: "causally later despite an earlier source timestamp",
      })
      const secondAssistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:02.000Z")),
        assistantMessageID: secondAssistantMessageID,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:03.000Z")),
        assistantMessageID: secondAssistantMessageID,
        callID: "call_replay",
        tool: "echo",
        input: { text: "second turn" },
        provider: { executed: false },
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:04.000Z")),
        assistantMessageID: secondAssistantMessageID,
        callID: "call_replay",
        structured: {},
        content: [],
        provider: { executed: false },
      })
      const db = Database.primary((yield* Database.Service).db)
      const taskID = SessionTask.ID.create()
      yield* db
        .insert(SessionTaskTable)
        .values({
          id: taskID,
          root_session_id: created.id,
          parent_session_id: created.id,
          child_session_id: SessionV2.ID.create(),
          actor_session_id: created.id,
          actor_assistant_message_id: assistantMessageID,
          actor_tool_call_id: "call_replay",
          agent: AgentV2.ID.make("build"),
          prompt: Prompt.make({ text: "replay task" }),
          description: "replay task",
          depth: 1,
          status: "starting",
          revision: 0,
          parent_permissions: [],
          ancestor_permission_sets: [],
          child_permissions: [],
          hard_permissions: [],
          write_roots: [location.directory],
          commands: [],
          time_created: Date.parse("2026-08-20T12:00:01.000Z"),
          time_updated: Date.parse("2026-08-20T12:00:01.000Z"),
        })
        .run()
        .pipe(Effect.orDie)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: taskID, seq: 0 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.create(),
          aggregate_id: taskID,
          seq: 0,
          type: EventV2.versionedType(SessionEvent.Task.OperationUpdated.type, 1),
          data: {
            sessionID: created.id,
            taskID,
            timestamp: Date.parse("2026-08-20T12:00:01.000Z"),
            operation: {
              id: SessionTask.OperationID.create(),
              taskID,
              rootSessionID: created.id,
              actor: { sessionID: created.id, assistantMessageID, toolCallID: "call_replay" },
              kind: "send",
              requestHash: "a".repeat(64),
              status: "pending",
              time: {
                created: Date.parse("2026-08-20T12:00:01.000Z"),
                updated: Date.parse("2026-08-20T12:00:01.000Z"),
              },
            },
          },
        })
        .run()
        .pipe(Effect.orDie)

      const metadata = yield* session.replay({ query: "is:session agent:build model:anthropic", limit: 20 })
      const event = yield* session.replay({
        query: "type:tool tool:bash agent:build model:anthropic typecheck after:2026-08-20 before:2026-08-21",
        limit: 20,
      })

      expect(metadata.entries.some((entry) => entry.session.id === created.id)).toBe(true)
      expect(event.entries).toHaveLength(1)
      expect(event.entries[0]?.event).toMatchObject({ type: "session.next.tool.called", seq: 2 })
      expect(event.entries[0]?.session.id).toBe(created.id)
      const echoSuccess = yield* session.replay({
        query: `session:${created.id} type:tool.success tool:echo`,
        limit: 20,
      })
      expect(echoSuccess).toMatchObject({ entries: [{ event: { type: "session.next.tool.success", seq: 6 } }] })
      const anchored = yield* session.replayHistory({
        sessionID: created.id,
        anchor: echoSuccess.entries[0]!.event!.id,
        limit: 3,
      })
      expect(anchored.events).toHaveLength(3)
      expect(anchored.events.map((item) => item.id)).toContain(echoSuccess.entries[0]!.event!.id)
      expect(anchored.previousCursor).toBeTruthy()
      const previous = yield* session.replayHistory({
        sessionID: created.id,
        cursor: anchored.previousCursor,
        direction: "before",
        limit: 3,
      })
      expect(previous.events.map((item) => item.id)).not.toContain(anchored.events[0]!.id)
      expect(
        yield* session.replay({ query: `session:${created.id} type:tool.success tool:bash`, limit: 20 }),
      ).toMatchObject({
        entries: [],
      })
      const task = yield* session.replay({
        query: `session:${created.id} type:task status:pending call:call_replay message:${assistantMessageID}`,
        limit: 20,
      })
      expect(task.entries[0]?.event).toMatchObject({
        type: "session.next.task.operation.updated",
        aggregateID: taskID,
        seq: 0,
      })

      const firstHistory = yield* session.replayHistory({ sessionID: created.id, limit: 2 })
      const secondHistory = yield* session.replayHistory({
        sessionID: created.id,
        cursor: firstHistory.nextCursor,
        limit: 20,
      })
      const replayed = [...firstHistory.events, ...secondHistory.events]
      expect(replayed.map((item) => item.type)).toContain("session.created")
      expect(replayed.map((item) => item.type)).toContain("session.next.task.operation.updated")
      expect(new Set(replayed.map((item) => item.id)).size).toBe(replayed.length)
      expect(
        replayed.filter((item) => item.durable.aggregateID === created.id).map((item) => item.durable.seq),
      ).toEqual([0, 1, 2, 3, 4, 5, 6])

      const firstSearch = yield* session.replay({ query: `session:${created.id} is:event`, limit: 2 })
      const secondSearch = yield* session.replay({
        query: `session:${created.id} is:event`,
        cursor: firstSearch.nextCursor,
        limit: 20,
      })
      const searchEvents = [...firstSearch.entries, ...secondSearch.entries]
      expect(firstSearch.total).toBe(secondSearch.total)
      expect(new Set(searchEvents.map((entry) => entry.event?.id)).size).toBe(searchEvents.length)

      yield* session.create({ location })
      yield* session.create({ location })
      const firstSessions = yield* session.replay({ query: "is:session", limit: 2 })
      const anchorSession = firstSessions.entries.at(-1)!.session.id
      yield* db
        .update(SessionTable)
        .set({ time_updated: Date.now() + 60_000 })
        .where(eq(SessionTable.id, anchorSession))
        .run()
        .pipe(Effect.orDie)
      const secondSessions = yield* session.replay({
        query: "is:session",
        cursor: firstSessions.nextCursor,
        limit: 20,
      })
      expect(secondSessions.entries.map((entry) => entry.session.id)).not.toContain(
        firstSessions.entries[0]!.session.id,
      )

      const repaired = yield* session.replay({ query: `session:${created.id} type:tool tool:bash`, limit: 20 })
      expect(repaired.entries[0]?.event).toMatchObject({ type: "session.next.tool.called", seq: 2 })
      expect(yield* session.replay({ query: "type:not-a-real-event", limit: 20 })).toMatchObject({
        entries: [],
        total: 0,
      })
    }),
  )

  it.effect("filters indexed failures without scanning unrelated event payloads", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:00.000Z")),
        assistantMessageID,
        error: { type: "unknown", message: "quota exhausted" },
      })

      const result = yield* session.replay({ query: `session:${created.id} has:error quota`, limit: 20 })

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]?.event).toMatchObject({
        type: "session.next.step.failed",
        messageID: assistantMessageID,
      })
    }),
  )
})
