import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import type { Config } from "@turenlabs/core/config"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionCompaction } from "@turenlabs/core/session/compaction"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionMessageUpdater } from "@turenlabs/core/session/message-updater"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionHistory } from "@turenlabs/core/session/history"
import { ProviderUsageTable, SessionInputTable, SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@turenlabs/core/snapshot"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

const messageRow = (message: SessionMessage.Message, seq: number) => {
  const { id, type, ...data } = encodeMessage(message)
  return {
    id: SessionMessage.ID.make(id),
    session_id: sessionID,
    type,
    seq,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}

const completedTool = (id: string, output: string): SessionMessage.AssistantTool => ({
  type: "tool",
  id,
  name: "bash",
  state: { status: "completed", input: {}, content: [{ type: "text", text: output }], structured: {} },
  time: { created },
})

const assistantWith = (id: string, content: readonly SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: "build",
    model,
    content: [...content],
    time: { created },
  })

const userSaying = (id: string, text: string) =>
  SessionMessage.User.make({ id: SessionMessage.ID.make(id), type: "user", text, time: { created } })

describe("SessionProjector", () => {
  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
        kind: "prompt",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      const summarized = yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
        status: "completed",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("marks a session compacting and clears the mark when compaction ends", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const compacting = () =>
        db
          .select({ value: SessionTable.time_compacting })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.value ?? null),
          )
      const compactionID = SessionMessage.ID.create()

      expect(yield* compacting()).toBeNull()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
      })
      expect(yield* compacting()).toBe(1)
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "auto",
        text: "summary",
        recent: "recent",
      })
      expect(yield* compacting()).toBeNull()

      const failedID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: failedID,
        timestamp: DateTime.makeUnsafe(3),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        messageID: failedID,
        timestamp: DateTime.makeUnsafe(4),
        mode: "manual",
        reason: "providerFailed",
      })
      expect(yield* compacting()).toBeNull()
      expect(
        yield* db
          .select({ status: SessionTable.status })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ status: "idle" })
    }),
  )

  it.effect("clears a compacting mark left behind by a compaction that never ended", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const compacting = () =>
        db
          .select({ value: SessionTable.time_compacting })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.value ?? null),
          )

      // compaction.ts has silent failure exits after Compaction.Started is published and
      // publishes no Ended, so a Started/Ended pairing alone would pin the session as
      // "compacting" forever. The next model step has to heal it.
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
      })
      expect(yield* compacting()).toBe(1)
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(2),
        agent: "build",
        model,
      })
      expect(yield* compacting()).toBeNull()
    }),
  )

  it.effect("marks pruned tool output durably, leaves the output in place, and never re-marks it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      // PRUNE_PROTECT is 40k tokens (~160k chars) and PRUNE_MINIMUM is 20k tokens (~80k chars):
      // the two oldest results fall outside the protect window and together clear the minimum,
      // while the newest one sits inside it and the last two turns are exempt outright.
      // Distinct fillers on purpose: identical ones would route the older call through dedup
      // (read-time, no durable mark), and this test is about the durable Pruned mark lifecycle.
      const stale = "s".repeat(80_000)
      const stale2 = "r".repeat(80_000)
      const guarded = "p".repeat(120_000)
      const transcript = [
        userSaying("msg_u1", "first"),
        assistantWith("msg_a1", [completedTool("call_1", stale)]),
        userSaying("msg_u2", "second"),
        assistantWith("msg_a2", [completedTool("call_2", stale2)]),
        userSaying("msg_u3", "third"),
        assistantWith("msg_a3", [completedTool("call_3", guarded)]),
        userSaying("msg_u4", "fourth"),
        assistantWith("msg_a4", []),
        userSaying("msg_u5", "fifth"),
      ]
      yield* db.insert(SessionMessageTable).values(transcript.map(messageRow)).run().pipe(Effect.orDie)

      const events = yield* EventV2.Service
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: () => Stream.empty },
        config: Effect.succeed([
          { type: "document", info: { compaction: { prune: true } } },
        ] as unknown as readonly Config.Entry[]),
      })

      /** The transcript as the runner re-reads it each turn: the projection, not an in-memory copy. */
      const history = () =>
        db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.map((row) => ({
                message: Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
              })),
            ),
          )
      const marks = () =>
        history().pipe(
          Effect.map((entries) =>
            entries.flatMap((entry) =>
              entry.message.type === "assistant"
                ? entry.message.content.flatMap((item) =>
                    item.type === "tool"
                      ? [
                          {
                            call: item.id,
                            pruned:
                              item.time.pruned === undefined ? undefined : DateTime.toEpochMillis(item.time.pruned),
                            output: item.state.status === "completed" ? item.state.content : [],
                          },
                        ]
                      : [],
                  )
                : [],
            ),
          ),
        )
      /** Calls the model no longer sees, read off the pruned view the runner hands the provider. */
      const sentinels = (entries: readonly { readonly message: SessionMessage.Message }[]) =>
        entries.flatMap((entry) =>
          entry.message.type === "assistant"
            ? entry.message.content.flatMap((item) =>
                item.type === "tool" &&
                item.state.status === "completed" &&
                item.state.content.some(
                  (piece) => piece.type === "text" && piece.text === SessionCompaction.PRUNED_TEXT,
                )
                  ? [item.id]
                  : [],
              )
            : [],
        )
      const published = () =>
        db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Compaction.Pruned.type, 1)))
          .all()
          .pipe(Effect.orDie)

      expect((yield* marks()).map((mark) => mark.pruned)).toEqual([undefined, undefined, undefined])

      expect(sentinels(yield* compaction.prune(sessionID, yield* history()))).toEqual(["call_1", "call_2"])

      const first = yield* published()
      expect(first).toHaveLength(1)
      expect(first[0]?.data).toMatchObject({
        entries: [
          { assistantMessageID: "msg_a1", callID: "call_1" },
          { assistantMessageID: "msg_a2", callID: "call_2" },
        ],
      })

      const marked = yield* marks()
      expect(marked.map((mark) => mark.call)).toEqual(["call_1", "call_2", "call_3"])
      // Marked exactly where the model's view diverged from the transcript, and stamped with the
      // event's own timestamp rather than whenever the projection happened to run.
      const stamp = (first[0]?.data as { readonly timestamp: number }).timestamp
      expect(marked[0]?.pruned).toBe(stamp)
      expect(marked[1]?.pruned).toBe(stamp)
      // ...and nowhere else: the protected result is still live context, so it carries no mark.
      expect(marked[2]?.pruned).toBeUndefined()
      // Mark only. The stored output is untouched, which is the entire point: the user keeps their
      // history while the model does not, and the desktop can say so instead of silently rendering
      // 80 000 characters the model can no longer see.
      expect(marked[0]?.output).toEqual([{ type: "text", text: stale }])

      // The next turn re-reads the marked transcript. `pruneEntries` honours the existing mark
      // rather than re-targeting it, so the model still sees sentinels and nothing is republished.
      expect(sentinels(yield* compaction.prune(sessionID, yield* history()))).toEqual(["call_1", "call_2"])
      expect(yield* published()).toHaveLength(1)
      expect((yield* marks()).map((mark) => mark.pruned)).toEqual(marked.map((mark) => mark.pruned))

      // Replaying the event itself is idempotent too: a mark that already exists is never moved,
      // so its meaning stays "when the model stopped seeing this" rather than "when this event was
      // last projected".
      yield* events.publish(SessionEvent.Compaction.Pruned, {
        sessionID,
        timestamp: DateTime.makeUnsafe(9_999),
        entries: [{ assistantMessageID: SessionMessage.ID.make("msg_a1"), callID: "call_1" }],
        freed: 20_000,
      })
      expect((yield* marks()).map((mark) => mark.pruned)).toEqual(marked.map((mark) => mark.pruned))
    }),
  )

  it.effect("keeps original messages committed after the summarized boundary", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const summarizedID = SessionMessage.ID.create()
      const summarized = yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: summarizedID,
        timestamp: DateTime.makeUnsafe(1),
        text: "summarized",
      })
      const retainedID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: retainedID,
        timestamp: DateTime.makeUnsafe(2),
        text: "committed while summarizing",
      })
      if (!summarized.durable) throw new Error("expected a durable synthetic event")
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(3),
        reason: "auto",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(4),
        reason: "auto",
        text: "summary",
        recent: "",
        throughSeq: summarized.durable.seq,
      })

      expect((yield* SessionHistory.load(db, sessionID)).map((message) => message.type)).toEqual([
        "compaction",
        "synthetic",
      ])
      expect((yield* SessionHistory.load(db, sessionID))[1]).toMatchObject({
        type: "synthetic",
        text: "committed while summarizing",
      })
      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage).toMatchObject([{ id: summarizedID, type: "synthetic", text: "summarized" }])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage).toMatchObject([{ id: retainedID, type: "synthetic", text: "committed while summarizing" }])
      expect(
        yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        }),
      ).toMatchObject([{ id: summarizedID, type: "synthetic" }])
      expect(yield* sessions.message({ sessionID, messageID: summarizedID })).toMatchObject({
        id: summarizedID,
        type: "synthetic",
        text: "summarized",
      })
      expect(yield* SessionHistory.needsContinuation(db, sessionID)).toBe(true)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("rejects a second durable admission for one permanent identity", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_permanent_admission")
      const first = {
        sessionID,
        messageID: id,
        timestamp: created,
        prompt: Prompt.make({ text: "first" }),
        delivery: "steer" as const,
      }
      yield* events.publish(SessionEvent.PromptAdmitted, first)

      expect(
        yield* events
          .publish(SessionEvent.PromptAdmitted, { ...first, prompt: Prompt.make({ text: "changed" }) })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(yield* events.publish(SessionEvent.PromptAdmitted, first).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .all()
          .pipe(Effect.orDie)).filter(
          (event) => event.type === EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})

describe("SessionProjector usage roll-up", () => {
  const seed = Effect.fnUntraced(function* (rows: ReadonlyArray<ReturnType<typeof assistantRow>>) {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    if (rows.length > 0)
      yield* db
        .insert(SessionMessageTable)
        .values([...rows])
        .run()
        .pipe(Effect.orDie)
    return db
  })

  const totals = Effect.fnUntraced(function* (db: Database.Interface["db"]) {
    return yield* db
      .select({
        cost: SessionTable.cost,
        input: SessionTable.tokens_input,
        output: SessionTable.tokens_output,
        reasoning: SessionTable.tokens_reasoning,
        read: SessionTable.tokens_cache_read,
        write: SessionTable.tokens_cache_write,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

  it.effect("rolls up what the turn was billed for, not what its last request occupied", () =>
    Effect.gen(function* () {
      const db = yield* seed([
        assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
        assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
      ])
      const events = yield* EventV2.Service
      // A transport that loops internally: the window held 1_000 fresh + 50_000
      // cached at the last round trip, but the run as a whole processed far more.
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_1"),
        finish: "tool-calls",
        cost: 0.25,
        tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 50_000, write: 0 } },
        billed: { input: 3_000, output: 120, reasoning: 30, cache: { read: 150_000, write: 2_000 } },
      })
      // A single-request provider, where the two are the same number and only
      // `tokens` is sent.
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0.5,
        tokens: { input: 200, output: 10, reasoning: 5, cache: { read: 1_000, write: 100 } },
      })

      expect(yield* totals(db)).toEqual({
        cost: 0.75,
        input: 3_200,
        output: 130,
        reasoning: 35,
        read: 151_000,
        write: 2_100,
      })
      // Occupancy stayed on the message it describes and never joined the sum.
      const row = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_assistant_1")))
        .get()
        .pipe(Effect.orDie)
      expect(row?.data).toMatchObject({
        tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 50_000, write: 0 } },
      })
    }),
  )

  it.effect("takes a reverted turn back out of the roll-up", () =>
    Effect.gen(function* () {
      const db = yield* seed([
        assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
        assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
      ])
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_1"),
        finish: "tool-calls",
        cost: 0.25,
        tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 50_000, write: 0 } },
        billed: { input: 3_000, output: 120, reasoning: 30, cache: { read: 150_000, write: 2_000 } },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0.5,
        tokens: { input: 200, output: 10, reasoning: 5, cache: { read: 1_000, write: 100 } },
      })

      // Revert to the first assistant message: it survives, everything after it goes.
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: SessionMessage.ID.make("msg_assistant_1") },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        messageID: SessionMessage.ID.make("msg_assistant_1"),
      })

      expect(
        (yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)).map((row) => row.id),
      ).toEqual([SessionMessage.ID.make("msg_assistant_1")])
      // Exactly the second turn came off; the surviving turn's billed figures stand.
      expect(yield* totals(db)).toEqual({
        cost: 0.25,
        input: 3_000,
        output: 120,
        reasoning: 30,
        read: 150_000,
        write: 2_000,
      })
    }),
  )

  it.effect("leaves a transcript it never billed for alone, and never goes negative", () =>
    Effect.gen(function* () {
      // Stands in for a fork or an adopted V1 transcript: message rows this
      // session holds without owning the `Step.Ended` events behind them.
      const db = yield* seed([
        assistantRow(SessionMessage.ID.make("msg_assistant_1"), -2),
        assistantRow(SessionMessage.ID.make("msg_assistant_inherited"), -1),
      ])
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: SessionMessage.ID.make("msg_assistant_1") },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        messageID: SessionMessage.ID.make("msg_assistant_1"),
      })

      expect(yield* totals(db)).toEqual({ cost: 0, input: 0, output: 0, reasoning: 0, read: 0, write: 0 })
    }),
  )

  const first = SessionMessage.ID.make("msg_assistant_1")
  const second = SessionMessage.ID.make("msg_assistant_2")

  const providerRows = Effect.fnUntraced(function* (db: Database.Interface["db"]) {
    return yield* db
      .select()
      .from(ProviderUsageTable)
      .where(eq(ProviderUsageTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
  })

  // The same looping transport as above: `tokens` is only its last round trip,
  // so the per-provider row has to carry `billed` for the reason the session
  // columns do.
  const settled = (assistantMessageID: SessionMessage.ID, timestamp: number) => ({
    sessionID,
    timestamp: DateTime.makeUnsafe(timestamp),
    assistantMessageID,
    finish: "stop",
    model,
    cost: 0.25,
    tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 50_000, write: 0 } },
    billed: { input: 3_000, output: 120, reasoning: 30, cache: { read: 150_000, write: 2_000 } },
  })

  it.effect("records one provider_usage row per settled turn, and re-projection does not add a second", () =>
    Effect.gen(function* () {
      const db = yield* seed([assistantRow(first, 0)])
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Ended, settled(first, 1))
      const expected = [
        {
          session_id: sessionID,
          assistant_message_id: first,
          provider_id: model.providerID,
          time: 1,
          cost: 0.25,
          tokens_input: 3_000,
          tokens_output: 120,
          tokens_reasoning: 30,
          tokens_cache_read: 150_000,
          tokens_cache_write: 2_000,
        },
      ]
      expect(yield* providerRows(db)).toEqual(expected)

      // The durable event projected a second time: same key, same totals.
      yield* events.publish(SessionEvent.Step.Ended, settled(first, 1))
      expect(yield* providerRows(db)).toEqual(expected)
    }),
  )

  it.effect("drops the provider_usage row for a turn a commit-revert removed", () =>
    Effect.gen(function* () {
      const db = yield* seed([assistantRow(first, 0), assistantRow(second, 1)])
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Ended, settled(first, 1))
      yield* events.publish(SessionEvent.Step.Ended, settled(second, 2))

      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: first },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        messageID: first,
      })

      expect((yield* providerRows(db)).map((row) => row.assistant_message_id)).toEqual([first])
    }),
  )

  it.effect("attributes historical Step.Ended rows from the matching Step.Started model ref", () =>
    Effect.gen(function* () {
      const db = yield* seed([])
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(0),
        assistantMessageID: first,
        agent: "build",
        model,
      })
      yield* Effect.forEach(
        Array.from({ length: 128 }, (_, index) => index),
        (index) =>
          events.publish(SessionEvent.Step.Started, {
            sessionID,
            timestamp: DateTime.makeUnsafe(index + 1),
            assistantMessageID: SessionMessage.ID.make(`msg_unrelated_${index}`),
            agent: "build",
            model: {
              id: ModelV2.ID.make(`model_unrelated_${index}`),
              providerID: ProviderV2.ID.make(`provider_unrelated_${index}`),
            },
          }),
        { concurrency: 1 },
      )
      const { model: _, ...withoutModel } = settled(first, 129)
      yield* events.publish(SessionEvent.Step.Ended, withoutModel)

      expect((yield* providerRows(db)).map((row) => row.provider_id)).toEqual([model.providerID])
    }),
  )
})
