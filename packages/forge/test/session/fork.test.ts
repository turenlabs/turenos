import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Database } from "@turenlabs/core/database/database"
import { EventV2 } from "@turenlabs/core/event"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Prompt } from "@turenlabs/core/session/prompt"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageIdentityTable,
  SessionMessageTable,
  SessionTable,
  SessionTranscriptAdoptionTable,
} from "@turenlabs/core/session/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { DateTime, Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { MessageID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionNs.node, SessionProjector.node])),
)

const model = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model"), variant: undefined }

/**
 * Builds a Session the way the running app builds one: created through
 * `Session.create`, then filled in exclusively by durable Session V2 events. The
 * legacy `message`/`part` tables stay empty, which is what every session in a live
 * database looks like — a fixture assembled from V1 rows would let a V1-shaped
 * fork pass here while returning an empty (or 404ing) fork in production.
 */
const seed = Effect.fn("Test.seed")(function* (input: { readonly title: string }) {
  const session = yield* SessionNs.Service
  const events = yield* EventV2.Service
  const created = yield* session.create({ title: input.title })
  const sessionID = created.id

  const prompt = Effect.fn("Test.prompt")(function* (text: string, at: number) {
    const messageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Prompted, {
      sessionID,
      messageID,
      prompt: Prompt.make({ text }),
      delivery: "steer",
      timestamp: DateTime.makeUnsafe(at),
    })
    return messageID
  })

  const turn = Effect.fn("Test.turn")(function* (text: string, at: number) {
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: "build",
      model,
      timestamp: DateTime.makeUnsafe(at),
    })
    yield* events.publish(SessionEvent.Text.Started, {
      sessionID,
      assistantMessageID,
      textID: `txt_${at}`,
      timestamp: DateTime.makeUnsafe(at + 1),
    })
    yield* events.publish(SessionEvent.Text.Ended, {
      sessionID,
      assistantMessageID,
      textID: `txt_${at}`,
      text,
      timestamp: DateTime.makeUnsafe(at + 2),
    })
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: "end_turn",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      timestamp: DateTime.makeUnsafe(at + 3),
    })
    return assistantMessageID
  })

  const first = yield* prompt("first", 1_000)
  yield* turn("first reply", 1_010)
  const second = yield* prompt("second", 1_020)
  yield* turn("second reply", 1_030)

  // Every live session picks up an adoption marker the first time a Session V2
  // read touches it (`SessionTranscriptAdoption.ensure`); these are the rows a
  // completed adoption leaves behind.
  const { db } = yield* Database.Service
  yield* Database.primary(db)
    .insert(SessionTranscriptAdoptionTable)
    .values({ session_id: sessionID, state: "current", version: 1, time_started: 1, time_completed: 2 })
    .run()
    .pipe(Effect.orDie)

  return { session, events, sessionID, first, second }
})

/** Reads the rendered text out of a stored row, whichever message shape it is. */
const text = (row: typeof SessionMessageTable.$inferSelect) => {
  const data = row.data as { text?: string; content?: ReadonlyArray<{ type: string; text?: string }> }
  if (data.text !== undefined) return data.text
  return (data.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
}

const rowsOf = Effect.fn("Test.rowsOf")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  return yield* Database.primary(db)
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(SessionMessageTable.seq)
    .all()
    .pipe(Effect.orDie)
})

describe("Session.fork", () => {
  it.instance("copies the Session V2 transcript of a session shaped like a live one", () =>
    Effect.gen(function* () {
      const { session, sessionID } = yield* seed({ title: "original" })
      const { db } = yield* Database.Service
      const primary = Database.primary(db)

      // Fixture fidelity: production has zero legacy rows, so the fork must not
      // be able to lean on them.
      expect(yield* primary.$count(MessageTable, eq(MessageTable.session_id, sessionID)).pipe(Effect.orDie)).toBe(0)
      expect(yield* primary.$count(PartTable, eq(PartTable.session_id, sessionID)).pipe(Effect.orDie)).toBe(0)

      const source = yield* rowsOf(sessionID)
      expect(source.map((row) => row.type)).toEqual(["user", "assistant", "user", "assistant"])

      const forked = yield* session.fork({ sessionID })
      expect(forked.id).not.toBe(sessionID)
      expect(forked.title).toBe("original (fork #1)")

      const copied = yield* rowsOf(forked.id)
      expect(copied.map((row) => row.type)).toEqual(source.map((row) => row.type))
      expect(copied.map(text)).toEqual(["first", "first reply", "second", "second reply"])
      expect(copied.map((row) => row.data)).toEqual(source.map((row) => row.data))
      expect(copied.map((row) => row.time_created)).toEqual(source.map((row) => row.time_created))
      // New identities, never the source's.
      expect(copied.some((row) => source.some((original) => original.id === row.id))).toBe(false)
      expect(new Set(copied.map((row) => row.id)).size).toBe(copied.length)

      // The source is untouched.
      expect((yield* rowsOf(sessionID)).map((row) => row.id)).toEqual(source.map((row) => row.id))
    }),
  )

  it.instance("seats the copied transcript ahead of the fork's own event log", () =>
    Effect.gen(function* () {
      const { session, events, sessionID } = yield* seed({ title: "seqs" })
      const forked = yield* session.fork({ sessionID })

      const copied = yield* rowsOf(forked.id)
      expect(copied.length).toBe(4)
      expect(copied.every((row) => row.seq < 0)).toBe(true)
      expect(copied.map((row) => row.seq)).toEqual([...copied.map((row) => row.seq)].sort((a, b) => a - b))

      // A UNIQUE (session_id, seq) collision here would be an unrecoverable
      // defect on the projector's write path, so prove a real durable event on
      // the fork lands past the transcript it inherited.
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: forked.id,
        messageID,
        text: "after the fork",
        timestamp: DateTime.makeUnsafe(2_000),
      })
      const after = yield* rowsOf(forked.id)
      expect(after.length).toBe(5)
      expect(after.at(-1)!.id).toBe(messageID)
      expect(after.at(-1)!.seq).toBeGreaterThanOrEqual(0)
    }),
  )

  it.instance("gives every copied message a message-owned identity and no inbox row", () =>
    Effect.gen(function* () {
      const { session, sessionID } = yield* seed({ title: "identity" })
      const { db } = yield* Database.Service
      const primary = Database.primary(db)
      const forked = yield* session.fork({ sessionID })

      const copied = yield* rowsOf(forked.id)
      const identities = yield* primary
        .select()
        .from(SessionMessageIdentityTable)
        .where(eq(SessionMessageIdentityTable.session_id, forked.id))
        .all()
        .pipe(Effect.orDie)
      expect(identities.map((row) => row.id).sort()).toEqual(copied.map((row) => row.id).sort())
      expect(identities.every((row) => row.owner === "message" && row.kind === "message")).toBe(true)
      expect(identities.every((row) => row.state === "active")).toBe(true)

      // The source's user messages are inbox-owned; the copies are not, so the
      // fork must not inherit `session_input` rows.
      expect(
        yield* primary.$count(SessionInputTable, eq(SessionInputTable.session_id, sessionID)).pipe(Effect.orDie),
      ).toBe(2)
      expect(
        yield* primary.$count(SessionInputTable, eq(SessionInputTable.session_id, forked.id)).pipe(Effect.orDie),
      ).toBe(0)
    }),
  )

  it.instance("marks the fork adopted so Session V2 never tries to convert it", () =>
    Effect.gen(function* () {
      const { session, sessionID } = yield* seed({ title: "adopted" })
      const { db } = yield* Database.Service
      const forked = yield* session.fork({ sessionID })

      const marker = yield* Database.primary(db)
        .select()
        .from(SessionTranscriptAdoptionTable)
        .where(eq(SessionTranscriptAdoptionTable.session_id, forked.id))
        .get()
        .pipe(Effect.orDie)
      expect(marker?.state).toBe("current")
      expect(marker?.version).toBe(1)
    }),
  )

  it.instance("cuts the copy immediately before the selected message", () =>
    Effect.gen(function* () {
      const { session, sessionID, second } = yield* seed({ title: "cutoff" })
      const forked = yield* session.fork({ sessionID, messageID: MessageID.make(second) })

      const copied = yield* rowsOf(forked.id)
      expect(copied.map((row) => row.type)).toEqual(["user", "assistant"])
      expect(copied.map(text)).toEqual(["first", "first reply"])
    }),
  )

  it.instance("rejects a cutoff message that is not in the session without creating one", () =>
    Effect.gen(function* () {
      const { session, sessionID } = yield* seed({ title: "missing cutoff" })
      const { db } = yield* Database.Service
      const before = yield* rowsOf(sessionID)
      const sessions = yield* Database.primary(db).$count(SessionTable).pipe(Effect.orDie)

      const error = yield* session
        .fork({ sessionID, messageID: MessageID.make("msg_not_in_this_session") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(NotFoundError)
      expect((yield* rowsOf(sessionID)).length).toBe(before.length)
      // A rejected fork must not leave a half-built session behind.
      expect(yield* Database.primary(db).$count(SessionTable).pipe(Effect.orDie)).toBe(sessions)
    }),
  )

  it.instance("rewrites the embedded sessionID of copied synthetic messages", () =>
    Effect.gen(function* () {
      const { session, events, sessionID } = yield* seed({ title: "synthetic" })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        text: "tool ran on behalf of the user",
        timestamp: DateTime.makeUnsafe(1_100),
      })

      const forked = yield* session.fork({ sessionID })
      const copied = yield* rowsOf(forked.id)
      const synthetic = copied.find((row) => row.type === "synthetic")
      expect(synthetic).toBeDefined()
      expect((synthetic!.data as { sessionID?: string }).sessionID).toBe(forked.id)
    }),
  )

  it.instance("leaves the source's system-context deltas behind", () =>
    Effect.gen(function* () {
      const { session, events, sessionID } = yield* seed({ title: "system" })
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        text: "the working tree changed",
        timestamp: DateTime.makeUnsafe(1_100),
      })
      expect((yield* rowsOf(sessionID)).some((row) => row.type === "system")).toBe(true)

      const forked = yield* session.fork({ sessionID })
      expect((yield* rowsOf(forked.id)).some((row) => row.type === "system")).toBe(false)
    }),
  )

  it.instance("refuses to fork a legacy transcript that Session V2 has not adopted", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "legacy only" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID: created.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)

      const { db } = yield* Database.Service
      const before = yield* Database.primary(db)
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, created.id)))
        .all()
        .pipe(Effect.orDie)
      expect(before).toEqual([])

      const error = yield* session.fork({ sessionID: created.id }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(NotFoundError)
    }),
  )
})
