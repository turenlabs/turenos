import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Message } from "@turenlabs/llm"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionContextEpoch } from "@turenlabs/core/session/context-epoch"
import { SessionContextRequest } from "@turenlabs/core/session/context-request"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionContextEpochTable, SessionContextRequestTable, SessionTable } from "@turenlabs/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const sessionID = SessionSchema.ID.make("ses_context_request_test")
const configuration = { baselineSeq: 0, identity: JSON.stringify({ model: "first", system: ["baseline"], tools: [] }) }
const entry = (seq: number, text = `source ${seq}`): SessionContextRequest.Entry => ({
  seq,
  message: {
    id: SessionMessage.ID.make(`msg_context_${seq}`),
    type: "system",
    text,
    time: { created: DateTime.makeUnsafe(123456789) },
  },
})
const history = [entry(1), entry(3)]
const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const db = database.db
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: "context-request",
      directory: "/project",
      title: "Context request",
      version: "test",
    })
    .run()
  yield* db
    .insert(SessionContextEpochTable)
    .values({ session_id: sessionID, baseline: "baseline", baseline_seq: 0, snapshot: {} })
    .run()
  return db
})

const seed = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  entries: readonly SessionContextRequest.Entry[] = history,
) {
  const prepared = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
  const frame: SessionContextRequest.Frame = {
    entries: entries.map((item) =>
      item.message.type === "system" ? { ...item, message: { ...item.message, text: "materialized snapshot" } } : item,
    ),
    messages: [
      Message.user("frozen file bytes\n雪"),
      Message.system("runtime instruction"),
      Message.assistant("reply"),
    ],
    sources: prepared.sources,
    turn: "turn-1",
  }
  yield* SessionContextRequest.save(db, sessionID, { ...configuration, ...prepared, frame })
  return frame
})

describe("SessionContextRequest", () => {
  it.effect("prepare is read-only and saved materialized frames round-trip bytes and DateTime", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const initial = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history })
      expect(initial).toMatchObject({ generation: 1, reason: "initial", frame: undefined })
      expect(yield* db.select().from(SessionContextRequestTable).all()).toEqual([])

      const frame = yield* seed(db)
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history })
      expect(loaded).toMatchObject({ generation: 1, reason: undefined })
      expect(loaded.frame).toEqual(frame)
      expect(JSON.stringify(Schema.encodeSync(SessionContextRequest.Frame)(loaded.frame!))).toBe(
        JSON.stringify(Schema.encodeSync(SessionContextRequest.Frame)(frame)),
      )
      expect(DateTime.toEpochMillis(loaded.frame!.entries[0]!.message.time.created)).toBe(123456789)
      const stored = yield* db.select().from(SessionContextRequestTable).get()
      expect(stored?.data).toEqual(Schema.encodeSync(SessionContextRequest.Frame)(frame))
    }),
  )

  it.effect("appends reuse the saved prefix and stable saves retain the rebuild reason", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const frame = yield* seed(db)
      const next = yield* SessionContextRequest.prepare(db, sessionID, {
        ...configuration,
        history: [...history, entry(7)],
      })
      expect(next.generation).toBe(1)
      expect(next.reason).toBeUndefined()
      expect(next.frame).toEqual(frame)
      expect(next.sources).toHaveLength(3)
      yield* SessionContextRequest.save(db, sessionID, {
        ...configuration,
        generation: 2,
        reason: "history",
        frame,
      })
      yield* SessionContextRequest.save(db, sessionID, {
        ...configuration,
        generation: 2,
        frame: { ...frame, sources: next.sources, turn: "turn-2" },
      })
      expect((yield* db.select().from(SessionContextRequestTable).get())?.reason).toBe("history")
    }),
  )

  for (const scenario of [
    { name: "earlier edits", history: [entry(1, "edited"), entry(3)], reason: "history" },
    { name: "earlier deletions", history: [entry(3)], reason: "history" },
    { name: "tail deletions", history: [entry(1)], reason: "history" },
    { name: "insertions before the old prefix", history: [entry(0), ...history], reason: "history" },
    { name: "sequence changes", history: [{ ...history[0]!, seq: 2 }, history[1]!], reason: "history" },
    { name: "model identity changes", history, identity: "new-model", reason: "configuration" },
    { name: "baseline changes", history, baselineSeq: 9, reason: "baseline" },
  ]) {
    it.effect(`rebuilds for ${scenario.name} without changing the stored row`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        yield* seed(db)
        const next = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, ...scenario })
        expect(next).toMatchObject({ generation: 2, reason: scenario.reason, frame: undefined })
        expect((yield* db.select().from(SessionContextRequestTable).get())?.generation).toBe(1)
      }),
    )
  }

  it.effect("ignores only tool pruning timestamps without mutating source history", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const message = Schema.decodeUnknownSync(SessionMessage.Assistant)({
        id: "msg_tool",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        time: { created: 100 },
        content: [
          {
            type: "tool",
            id: "call-1",
            name: "read",
            state: { status: "completed", input: {}, content: [], structured: {} },
            time: { created: 100, completed: 200 },
          },
        ],
      })
      const frame = yield* seed(db, [{ seq: 1, message }])
      const pruned: SessionMessage.Assistant = {
        ...message,
        content: message.content.map((part) =>
          part.type === "tool" ? { ...part, time: { ...part.time, pruned: DateTime.makeUnsafe(300) } } : part,
        ),
      }
      const before = Schema.encodeSync(SessionMessage.Assistant)(pruned)
      const next = yield* SessionContextRequest.prepare(db, sessionID, {
        ...configuration,
        history: [{ seq: 1, message: pruned }],
      })
      expect(next.frame).toEqual(frame)
      expect(next.reason).toBeUndefined()
      expect(Schema.encodeSync(SessionMessage.Assistant)(pruned)).toEqual(before)
      const changed = yield* SessionContextRequest.prepare(db, sessionID, {
        ...configuration,
        history: [
          {
            seq: 1,
            message: {
              ...pruned,
              content: pruned.content.map((part) =>
                part.type === "tool" ? { ...part, time: { ...part.time, completed: DateTime.makeUnsafe(400) } } : part,
              ),
            },
          },
        ],
      })
      expect(changed).toMatchObject({ generation: 2, reason: "history", frame: undefined })
    }),
  )

  it.effect("epoch reset cascades the frame and restarts at generation one", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* seed(db)
      yield* SessionContextEpoch.reset(db, sessionID)
      expect(yield* db.select().from(SessionContextRequestTable).all()).toEqual([])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeDefined()
      const next = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history })
      expect(next).toMatchObject({ generation: 1, reason: "initial", frame: undefined })
    }),
  )
})
