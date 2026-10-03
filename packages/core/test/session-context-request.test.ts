import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { LLM, Message, Model } from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionContextEpoch } from "@turenlabs/core/session/context-epoch"
import { ClaudeCodeBridge } from "@turenlabs/core/session/runner/claude-code-bridge"
import { SessionContextRequest } from "@turenlabs/core/session/context-request"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { FileAttachment } from "@turenlabs/core/session/prompt"
import {
  SessionContextBlobTable,
  SessionContextEpochTable,
  SessionContextRequestTable,
  SessionTable,
} from "@turenlabs/core/session/sql"
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

const encodeFrame = (Schema.encodeUnknownSync as unknown as (schema: unknown) => (value: unknown) => unknown)(
  SessionContextRequest.Frame,
)
const largeURI = (size: number, fill = "A") => `data:audio/mpeg;base64,${fill.repeat(size)}`
const attachmentEntry = (seq: number, uri: string): SessionContextRequest.Entry => ({
  seq,
  message: SessionMessage.User.make({
    id: SessionMessage.ID.make(`msg_context_${seq}`),
    type: "user",
    text: "see attached",
    files: [FileAttachment.make({ uri, mime: "audio/mpeg", name: "clip.mp3" })],
    time: { created: DateTime.makeUnsafe(123456789) },
  }),
})
const attachmentFrame = (
  entries: readonly SessionContextRequest.Entry[],
  uri: string,
  turn: string,
): Omit<SessionContextRequest.Frame, "sources"> => ({
  entries,
  messages: [Message.user([{ type: "media", mediaType: "audio/mpeg", data: uri, filename: "clip.mp3" }])],
  turn,
})
const saveFrame = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  entries: readonly SessionContextRequest.Entry[],
  frame: Omit<SessionContextRequest.Frame, "sources">,
) {
  const prepared = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
  const saved = { ...frame, sources: prepared.sources }
  yield* SessionContextRequest.save(db, sessionID, { ...configuration, ...prepared, frame: saved })
  return saved
})
const blobRows = (db: Database.Interface["db"]) => db.select().from(SessionContextBlobTable).all()
const rowText = (db: Database.Interface["db"]) =>
  db
    .select()
    .from(SessionContextRequestTable)
    .get()
    .pipe(Effect.map((row) => JSON.stringify(row?.data)))

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
      expect(JSON.stringify(encodeFrame(loaded.frame!))).toBe(JSON.stringify(encodeFrame(frame)))
      expect(DateTime.toEpochMillis(loaded.frame!.entries[0]!.message.time.created)).toBe(123456789)
      const stored = yield* db.select().from(SessionContextRequestTable).get()
      expect(stored?.data).toEqual(encodeFrame(frame))
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
  it.effect("externalizes one blob shared by entries and messages and hydrates byte-identical frames", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const uri = largeURI(200 * 1024)
      const entries = [attachmentEntry(1, uri)]
      const saved = yield* saveFrame(db, entries, attachmentFrame(entries, uri, "turn-1"))
      expect((yield* rowText(db)).length).toBeLessThan(10 * 1024)
      const blobs = yield* blobRows(db)
      expect(blobs).toHaveLength(1)
      expect(blobs[0]).toMatchObject({ session_id: sessionID, data: uri, size: uri.length })
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
      expect(loaded.frame).toEqual(saved)
      expect(JSON.stringify(encodeFrame(loaded.frame))).toBe(JSON.stringify(encodeFrame(saved)))
      expect(JSON.stringify(loaded.frame)).not.toContain("forge-context-blob:")
    }),
  )

  it.effect("keeps sub-threshold strings inline and externalizes legacy inline rows on the next save", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const small = largeURI(1024)
      const entries = [attachmentEntry(1, small)]
      yield* saveFrame(db, entries, attachmentFrame(entries, small, "turn-1"))
      expect(yield* blobRows(db)).toEqual([])
      expect(yield* rowText(db)).toContain(small)

      const uri = largeURI(100 * 1024, "B")
      const legacyEntries = [attachmentEntry(1, uri)]
      const legacy = { ...attachmentFrame(legacyEntries, uri, "turn-1"), sources: [] }
      yield* db
        .update(SessionContextRequestTable)
        .set({ data: encodeFrame(legacy) })
        .where(eq(SessionContextRequestTable.session_id, sessionID))
        .run()
      const prepared = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: [] })
      expect(prepared.frame?.messages).toEqual(legacy.messages)
      yield* SessionContextRequest.save(db, sessionID, { ...configuration, ...prepared, frame: prepared.frame! })
      expect(yield* blobRows(db)).toHaveLength(1)
      expect((yield* rowText(db)).length).toBeLessThan(10 * 1024)
    }),
  )

  it.effect("appending to a frame with an unchanged attachment adds no blob and does not grow the row", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const uri = largeURI(300 * 1024)
      const entries = [attachmentEntry(1, uri)]
      yield* saveFrame(db, entries, attachmentFrame(entries, uri, "turn-1"))
      const first = (yield* rowText(db)).length
      const prepared = yield* SessionContextRequest.prepare(db, sessionID, {
        ...configuration,
        history: [...entries, entry(3)],
      })
      const frame = prepared.frame!
      yield* SessionContextRequest.save(db, sessionID, {
        ...configuration,
        ...prepared,
        frame: {
          ...frame,
          entries: [...frame.entries, entry(3)],
          messages: [...frame.messages, Message.assistant("ok")],
          sources: prepared.sources,
          turn: "turn-2",
        },
      })
      expect(yield* blobRows(db)).toHaveLength(1)
      expect((yield* rowText(db)).length).toBeLessThan(first + 1024)
    }),
  )

  it.effect("collects only this session's unreferenced blobs and keeps the blobs just written", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const other = SessionSchema.ID.make("ses_context_request_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: ProjectV2.ID.global,
          slug: "context-request-other",
          directory: "/project",
          title: "Other",
          version: "test",
        })
        .run()
      yield* db
        .insert(SessionContextEpochTable)
        .values({ session_id: other, baseline: "baseline", baseline_seq: 0, snapshot: {} })
        .run()
      yield* db
        .insert(SessionContextBlobTable)
        .values({ session_id: other, sha256: "f".repeat(64), data: "other", size: 5 })
        .run()

      const first = largeURI(80 * 1024, "C")
      const second = largeURI(80 * 1024, "D")
      const entries = [attachmentEntry(1, first)]
      yield* saveFrame(db, entries, attachmentFrame(entries, first, "turn-1"))
      expect(yield* blobRows(db)).toHaveLength(2)

      // A pressure-shaped frame that drops the first attachment and carries a different one.
      const pressureEntries = [attachmentEntry(1, second)]
      const prepared = yield* SessionContextRequest.prepare(db, sessionID, {
        ...configuration,
        history: pressureEntries,
      })
      yield* SessionContextRequest.save(db, sessionID, {
        ...configuration,
        ...prepared,
        reason: "pressure",
        frame: { ...attachmentFrame(pressureEntries, second, "turn-2"), sources: prepared.sources },
      })
      const rows = yield* blobRows(db)
      expect(rows.filter((row) => row.session_id === sessionID).map((row) => row.data)).toEqual([second])
      expect(rows.filter((row) => row.session_id === other)).toHaveLength(1)
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, {
        ...configuration,
        history: pressureEntries,
      })
      expect(loaded.frame?.messages).toEqual(attachmentFrame(pressureEntries, second, "turn-2").messages)
    }),
  )

  it.effect("rebuilds instead of passing a reference on when its blob is missing", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const uri = largeURI(100 * 1024)
      const entries = [attachmentEntry(1, uri)]
      yield* saveFrame(db, entries, attachmentFrame(entries, uri, "turn-1"))
      yield* db.delete(SessionContextBlobTable).where(eq(SessionContextBlobTable.session_id, sessionID)).run()
      const prepared = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
      expect(prepared).toMatchObject({ generation: 2, reason: "history", frame: undefined })
      expect(JSON.stringify(prepared)).not.toContain("forge-context-blob:")
    }),
  )

  it.effect("stores a short string shaped like a reference as a blob so it hydrates to itself", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const literal = `forge-context-blob:sha256:${"a".repeat(64)}`
      const entries = [entry(1, literal)]
      const saved = yield* saveFrame(db, entries, { entries, messages: [Message.user(literal)], turn: "turn-1" })
      expect(yield* blobRows(db)).toHaveLength(1)
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
      expect(loaded.frame).toEqual(saved)
    }),
  )

  it.effect("replays a legacy row holding a reference-shaped literal unchanged", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const literal = `forge-context-blob:sha256:${"b".repeat(64)}`
      const entries = [entry(1, literal)]
      const saved = yield* seed(db, entries)
      const legacy = { entries, messages: [Message.user(literal)], sources: saved.sources, turn: "turn-1" }
      yield* db
        .update(SessionContextRequestTable)
        .set({ data: encodeFrame(legacy) })
        .where(eq(SessionContextRequestTable.session_id, sessionID))
        .run()
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
      expect(loaded).toMatchObject({ generation: 1, reason: undefined })
      expect(loaded.frame?.messages).toEqual(legacy.messages)
    }),
  )

  it.effect("keeps strings with lone surrogates inline so they round trip distinctly", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const high = largeURI(80 * 1024) + "\ud800"
      const low = largeURI(80 * 1024) + "\udc00"
      const entries = [attachmentEntry(1, high)]
      const frame = {
        entries,
        messages: [Message.user(high), Message.user(low)],
        turn: "turn-1",
      }
      const saved = yield* saveFrame(db, entries, frame)
      expect(yield* blobRows(db)).toEqual([])
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
      expect(loaded.frame).toEqual(saved)
    }),
  )

  it.effect("replayed frames hand the Claude Code bridge the original data: URI image bytes", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const base64 = "QUJD".repeat(50 * 1024)
      const uri = `data:image/png;base64,${base64}`
      const entries = [attachmentEntry(1, uri)]
      const request = (messages: readonly Message[]) =>
        LLM.request({ model: Model.make({ id: "model", provider: "provider", route: OpenAIChat.route }), messages })
      const messages = [Message.user([{ type: "media", mediaType: "image/png", data: uri, filename: "shot.png" }])]
      yield* saveFrame(db, entries, { entries, messages, turn: "turn-1" })
      expect(yield* blobRows(db)).toHaveLength(1)
      const loaded = yield* SessionContextRequest.prepare(db, sessionID, { ...configuration, history: entries })
      const replayed = ClaudeCodeBridge.content(request(loaded.frame!.messages))
      expect(replayed).toEqual(ClaudeCodeBridge.content(request(messages)))
      expect(replayed.at(-1)).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64 },
      })
    }),
  )

  it.effect("epoch reset cascades the blobs with the frame", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const uri = largeURI(100 * 1024)
      const entries = [attachmentEntry(1, uri)]
      yield* saveFrame(db, entries, attachmentFrame(entries, uri, "turn-1"))
      expect(yield* blobRows(db)).toHaveLength(1)
      yield* SessionContextEpoch.reset(db, sessionID)
      expect(yield* blobRows(db)).toEqual([])
    }),
  )
})
