import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionStore } from "@turenlabs/core/session/store"
import { eq } from "drizzle-orm"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionInput } from "@turenlabs/core/session/input"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
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

const GapEvent = EventV2.define({
  type: "test.session.history.gap",
  durable: { aggregate: "sessionID", version: 1 },
  schema: { sessionID: SessionV2.ID, value: Schema.String },
})

describe("SessionV2.history", () => {
  it.effect("returns an exhausted page for a migrated Session with no event sequence", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_empty_history")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "empty-history",
          directory: "/project",
          title: "Empty history",
          version: "test",
        })
        .run()

      const first = yield* session.history({ sessionID, limit: 10 })

      expect(first).toEqual({ events: [], hasMore: false, latest: -1 })
    }),
  )

  it.effect("treats after as an exclusive aggregate sequence", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })

      const page = yield* session.history({ sessionID: created.id, after: 1, limit: 10 })

      expect(page.events.map((event) => event.durable?.seq)).toEqual([2])
      expect(page.hasMore).toBe(false)
      expect(page.latest).toBe(2)
    }),
  )

  it.effect("paginates public events in aggregate order across filtered gaps without duplicates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* events.publish(GapEvent, { sessionID: created.id, value: "filtered" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })
      yield* session.switchAgent({ sessionID: created.id, agent: "three" })

      const first = yield* session.history({ sessionID: created.id, limit: 2 })
      const after = first.events.at(-1)?.durable?.seq
      const second = yield* session.history({
        sessionID: created.id,
        after,
        limit: 2,
      })
      const sequence = [...first.events, ...second.events].map((event) => event.durable?.seq)

      expect(first.hasMore).toBe(true)
      expect(first.latest).toBe(4)
      expect(second.hasMore).toBe(false)
      expect(sequence).toEqual([1, 3, 4])
      expect(new Set(sequence).size).toBe(sequence.length)
    }),
  )

  it.effect("includes events committed between pages", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })

      const first = yield* session.history({ sessionID: created.id, limit: 1 })
      yield* session.switchAgent({ sessionID: created.id, agent: "later" })
      const second = yield* session.history({
        sessionID: created.id,
        after: first.events.at(-1)?.durable?.seq,
        limit: 10,
      })

      expect(first.hasMore).toBe(true)
      expect([...first.events, ...second.events].map((event) => event.durable?.seq)).toEqual([1, 2, 3])
      expect(second.hasMore).toBe(false)
    }),
  )

  it.effect("reports exhaustion for exact-limit and limit-plus-one pages", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })

      const exact = yield* session.history({ sessionID: created.id, limit: 2 })
      const oneMore = yield* session.history({ sessionID: created.id, limit: 1 })
      const exhausted = yield* session.history({
        sessionID: created.id,
        after: oneMore.events.at(-1)?.durable?.seq,
        limit: 1,
      })

      expect(exact.events).toHaveLength(2)
      expect(exact.hasMore).toBe(false)
      expect(oneMore.events).toHaveLength(1)
      expect(oneMore.hasMore).toBe(true)
      expect(exhausted.events).toHaveLength(1)
      expect(exhausted.hasMore).toBe(false)
    }),
  )

  it.effect("fails with NotFoundError for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const error = yield* session.history({ sessionID: SessionV2.ID.make("ses_missing"), limit: 10 }).pipe(Effect.flip)

      expect(error._tag).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2 human transcript", () => {
  it.effect("pages durable turns through multiple compactions, retained tails, and committed revert", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      const expected: SessionMessage.ID[] = []
      const checkpoints: SessionMessage.ID[] = []
      const users: SessionMessage.ID[] = []
      for (let turn = 0; turn < 5; turn++) {
        const messageID = SessionMessage.ID.create()
        users.push(messageID)
        expected.push(messageID)
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: created.id,
          messageID,
          timestamp: DateTime.makeUnsafe(turn),
          prompt: { text: `Human turn ${turn}` },
          delivery: "steer",
        })
        const assistantMessageID = SessionMessage.ID.create()
        expected.push(assistantMessageID)
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: created.id,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(turn),
          agent: "build",
          model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
        })
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: created.id,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(turn),
          textID: `text_${turn}`,
        })
        yield* events.publish(SessionEvent.Text.Ended, {
          sessionID: created.id,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(turn),
          textID: `text_${turn}`,
          text: `Answer ${turn}`,
        })
        const ended = yield* events.publish(SessionEvent.Step.Ended, {
          sessionID: created.id,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(turn),
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        if (turn !== 1 && turn !== 3) continue
        const messageIDCheckpoint = SessionMessage.ID.create()
        checkpoints.push(messageIDCheckpoint)
        expected.push(messageIDCheckpoint)
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID: created.id,
          messageID: messageIDCheckpoint,
          timestamp: DateTime.makeUnsafe(turn),
          reason: "manual",
          text: `Summary through ${turn}`,
          recent: "",
          throughSeq: ended.durable!.seq,
        })
      }
      for (const order of ["asc", "desc"] as const) {
        const collected: SessionMessage.ID[] = []
        let cursor: { id: SessionMessage.ID; direction: "next" } | undefined
        for (;;) {
          const page = yield* session.messages({ sessionID: created.id, order, cursor, limit: 3 })
          if (page.length === 0) break
          collected.push(...page.map((message) => message.id))
          cursor = { id: page.at(-1)!.id, direction: "next" }
        }
        expect(collected).toEqual(order === "asc" ? expected : expected.toReversed())
        expect(new Set(collected).size).toBe(expected.length)
      }
      const modelContext = yield* session.context(created.id)
      expect(modelContext.map((message) => message.id)).toEqual([checkpoints[1], ...expected.slice(-2)])
      expect(modelContext[0]).toMatchObject({ summary: "Summary through 3" })
      expect(yield* session.message({ sessionID: created.id, messageID: expected[1]! })).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "Answer 0" }],
      })
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(6),
        revert: { messageID: users[2]!, files: [] },
      })
      expect((yield* session.messages({ sessionID: created.id, order: "asc" })).map((message) => message.id)).toEqual(
        expected,
      )
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(7),
        messageID: users[2]!,
      })
      expect((yield* session.messages({ sessionID: created.id, order: "asc" })).map((message) => message.id)).toEqual(
        expected.slice(0, expected.indexOf(users[2]!) + 1),
      )
      expect(
        yield* session.messages({ sessionID: created.id, cursor: { id: checkpoints[1]!, direction: "next" } }),
      ).toEqual([])
      expect(yield* session.message({ sessionID: created.id, messageID: expected.at(-1)! })).toBeUndefined()
      const database = yield* Database.Service
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run()
      expect((yield* session.messages({ sessionID: created.id }).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
    }),
  )

  it.effect("preserves provenance across admission, promotion, old projections, and exact retry", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const created = yield* session.create({ location })
      const userID = SessionMessage.ID.create()
      const prompt = { text: "Explain <forge-team-board-update> in this log." }
      const admitted = yield* session.prompt({ sessionID: created.id, id: userID, prompt, resume: false })
      const boardID = SessionMessage.ID.create()
      yield* SessionInput.admit(database.db, events, {
        sessionID: created.id,
        id: boardID,
        prompt: { text: "Quiet coordination" },
        delivery: "steer",
        source: "subagent_board",
        kind: "prompt",
        location,
      })
      expect((yield* session.pendingInputs(created.id)).map((input) => input.source)).toEqual([
        "user",
        "subagent_board",
      ])
      yield* SessionInput.promoteSteers(database.db, events, created.id, Number.MAX_SAFE_INTEGER)
      expect(
        (yield* session.messages({ sessionID: created.id, order: "asc" })).map(
          (message) => message.type === "user" && message.source,
        ),
      ).toEqual(["user", "subagent_board"])
      const board = yield* database.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, boardID))
        .get()
      const legacyData = { ...board!.data, source: undefined }
      yield* database.db
        .update(SessionMessageTable)
        .set({ data: legacyData })
        .where(eq(SessionMessageTable.id, boardID))
        .run()
      expect(yield* session.message({ sessionID: created.id, messageID: boardID })).toMatchObject({
        source: "subagent_board",
      })
      expect((yield* session.messages({ sessionID: created.id, order: "asc" }))[1]).toMatchObject({
        source: "subagent_board",
      })
      expect(yield* session.prompt({ sessionID: created.id, id: userID, prompt, resume: false })).toMatchObject({
        id: admitted.id,
        source: "user",
        prompt,
        admittedSeq: admitted.admittedSeq,
      })
      expect(
        (yield* session.messages({ sessionID: created.id })).filter((message) => message.id === userID),
      ).toHaveLength(1)
      expect(
        (yield* session
          .prompt({ sessionID: created.id, id: boardID, prompt: { text: "Quiet coordination" }, resume: false })
          .pipe(Effect.flip))._tag,
      ).toBe("Session.PromptConflictError")
    }),
  )
})
