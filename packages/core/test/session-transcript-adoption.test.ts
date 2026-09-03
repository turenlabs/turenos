import { describe, expect, test } from "bun:test"
import path from "path"
import { Model } from "@turenlabs/llm"
import { OpenAIChat } from "@turenlabs/llm/protocols"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionHistory } from "@turenlabs/core/session/history"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionLegacyExecution } from "@turenlabs/core/session/legacy-execution"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Prompt } from "@turenlabs/core/session/prompt"
import { toLLMMessages } from "@turenlabs/core/session/runner/to-llm-message"
import {
  MessageTable,
  PartTable,
  SessionMessageTable,
  SessionTable,
  SessionTranscriptAdoptionTable,
} from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTranscriptAdoption } from "@turenlabs/core/session/transcript-adoption"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const project = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const legacy = Layer.succeed(
  SessionLegacyExecution.Service,
  SessionLegacyExecution.Service.of({ quiesce: () => Effect.void }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionTranscriptAdoption.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, project],
      [SessionExecution.node, SessionExecution.noopLayer],
      [SessionLegacyExecution.node, legacy],
    ],
  ),
)
const directory = AbsolutePath.make("/project")
const location = Location.Ref.make({ directory })
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const setup = Effect.fnUntraced(function* (
  sessionID: SessionV2.ID,
  revert?: { readonly messageID: SessionMessage.ID },
) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: sessionID,
      directory,
      title: sessionID,
      version: "test",
      revert,
    })
    .run()
    .pipe(Effect.orDie)
  return yield* (yield* SessionV2.Service).get(sessionID)
})

const insertUser = Effect.fnUntraced(function* (
  sessionID: SessionV2.ID,
  suffix: string,
  time: number,
  input: { readonly text: string; readonly synthetic?: boolean; readonly system?: string },
) {
  const { db } = yield* Database.Service
  const id = SessionV1.MessageID.ascending(`msg_${suffix}`)
  const info = SessionV1.User.make({
    id,
    sessionID,
    role: "user",
    time: { created: time },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
    system: input.system,
  })
  const part = SessionV1.TextPart.make({
    id: SessionV1.PartID.ascending(`prt_${suffix}`),
    sessionID,
    messageID: id,
    type: "text",
    text: input.text,
    synthetic: input.synthetic,
  })
  const { id: messageID, sessionID: ignoredSessionID, ...data } = info
  const { id: partID, sessionID: ignoredPartSessionID, messageID: ignoredMessageID, ...partData } = part
  void ignoredSessionID
  void ignoredPartSessionID
  void ignoredMessageID
  yield* db
    .insert(MessageTable)
    .values({
      id: messageID,
      session_id: sessionID,
      time_created: time,
      time_updated: time,
      data: data as typeof MessageTable.$inferInsert.data,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values({
      id: partID,
      message_id: messageID,
      session_id: sessionID,
      time_created: time,
      time_updated: time,
      data: partData as typeof PartTable.$inferInsert.data,
    })
    .run()
    .pipe(Effect.orDie)
  return id
})

const insertAssistant = Effect.fnUntraced(function* (
  sessionID: SessionV2.ID,
  suffix: string,
  parentID: SessionV1.MessageID,
  time: number,
  input: { readonly text: string; readonly summary?: boolean },
) {
  const { db } = yield* Database.Service
  const id = SessionV1.MessageID.ascending(`msg_${suffix}`)
  const info = SessionV1.Assistant.make({
    id,
    sessionID,
    role: "assistant",
    time: { created: time, completed: time + 1 },
    parentID,
    modelID: ModelV2.ID.make("model"),
    providerID: ProviderV2.ID.make("provider"),
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    summary: input.summary,
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  const part = SessionV1.TextPart.make({
    id: SessionV1.PartID.ascending(`prt_${suffix}`),
    sessionID,
    messageID: id,
    type: "text",
    text: input.text,
  })
  const { id: messageID, sessionID: ignoredSessionID, ...data } = info
  const { id: partID, sessionID: ignoredPartSessionID, messageID: ignoredMessageID, ...partData } = part
  void ignoredSessionID
  void ignoredPartSessionID
  void ignoredMessageID
  yield* db
    .insert(MessageTable)
    .values({
      id: messageID,
      session_id: sessionID,
      time_created: time,
      time_updated: time,
      data: data as typeof MessageTable.$inferInsert.data,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values({
      id: partID,
      message_id: messageID,
      session_id: sessionID,
      time_created: time,
      time_updated: time,
      data: partData as typeof PartTable.$inferInsert.data,
    })
    .run()
    .pipe(Effect.orDie)
  return id
})

const adopt = Effect.fnUntraced(function* (sessionID: SessionV2.ID) {
  const session = yield* (yield* SessionV2.Service).get(sessionID)
  yield* (yield* SessionTranscriptAdoption.Service).ensure(session)
})

const currentID = (id: SessionV1.MessageID) => SessionMessage.ID.make(id)

describe("SessionTranscriptAdoption", () => {
  it.effect("adopts a cold legacy transcript before direct message and context reads", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_direct_reads")
      yield* setup(sessionID)
      const messageID = yield* insertUser(sessionID, "direct_reads", 10, { text: "cold legacy message" })
      const session = yield* SessionV2.Service

      expect(
        yield* session.message({
          sessionID,
          messageID: currentID(messageID),
        }),
      ).toMatchObject({ id: currentID(messageID), type: "user", text: "cold legacy message" })
      expect(yield* session.context(sessionID)).toEqual([
        expect.objectContaining({ id: currentID(messageID), type: "user", text: "cold legacy message" }),
      ])
      expect(yield* (yield* SessionTranscriptAdoption.Service).adopted(sessionID)).toBe(true)
    }),
  )

  it.effect("paginates negative history before the first current prompt", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_pagination")
      yield* setup(sessionID)
      const firstID = yield* insertUser(sessionID, "legacy_first", 10, { text: "first" })
      const secondID = yield* insertUser(sessionID, "legacy_second", 20, { text: "second" })

      const session = yield* SessionV2.Service
      const first = yield* session.messages({ sessionID, order: "asc", limit: 1 })
      const second = yield* session.messages({
        sessionID,
        order: "asc",
        limit: 1,
        cursor: { id: first[0]!.id, direction: "next" },
      })
      const admitted = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_current"),
        prompt: Prompt.make({ text: "current" }),
        resume: false,
      })
      const { db } = yield* Database.Service
      yield* SessionInput.promoteSteers(db, yield* EventV2.Service, sessionID, Number.MAX_SAFE_INTEGER)
      const rows = yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)

      expect(first.map((message) => message.id)).toEqual([currentID(firstID)])
      expect(second.map((message) => message.id)).toEqual([currentID(secondID)])
      expect(yield* (yield* SessionTranscriptAdoption.Service).adopted(sessionID)).toBe(true)
      expect(rows).toEqual([
        { id: currentID(firstID), seq: -2 },
        { id: currentID(secondID), seq: -1 },
        { id: admitted.id, seq: 1 },
      ])
    }),
  )

  it.effect("recovers an adopting marker and filters pre-compaction history", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_restart")
      yield* setup(sessionID)
      const oldUser = yield* insertUser(sessionID, "old_user", 10, { text: "old question" })
      yield* insertAssistant(sessionID, "old_answer", oldUser, 20, { text: "old answer" })
      const compactionPrompt = yield* insertUser(sessionID, "compaction_prompt", 30, {
        text: "What did we do so far?",
        synthetic: true,
      })
      const { db } = yield* Database.Service
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.ascending("prt_compaction_marker"),
          message_id: compactionPrompt,
          session_id: sessionID,
          time_created: 30,
          time_updated: 30,
          data: { type: "compaction", auto: true } as typeof PartTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      const summary = yield* insertAssistant(sessionID, "compaction_summary", compactionPrompt, 40, {
        text: "Condensed history",
        summary: true,
      })
      const latest = yield* insertUser(sessionID, "latest_user", 50, { text: "latest question" })
      yield* db
        .insert(SessionTranscriptAdoptionTable)
        .values({ session_id: sessionID, state: "adopting", version: 1, time_started: 1 })
        .run()
        .pipe(Effect.orDie)

      yield* adopt(sessionID)

      expect((yield* SessionHistory.load(db, sessionID)).map((message) => message.id)).toEqual([
        currentID(summary),
        currentID(latest),
      ])
      expect(
        yield* db
          .select({ state: SessionTranscriptAdoptionTable.state })
          .from(SessionTranscriptAdoptionTable)
          .where(eq(SessionTranscriptAdoptionTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "current" })
    }),
  )

  it.effect("keeps synthetic prompts internal and replays their historical system instruction", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_synthetic")
      yield* setup(sessionID)
      const id = yield* insertUser(sessionID, "synthetic_system", 10, {
        text: "internal continuation",
        synthetic: true,
        system: "historical system",
      })
      yield* adopt(sessionID)

      const message = yield* (yield* SessionV2.Service).message({ sessionID, messageID: SessionMessage.ID.make(id) })
      expect(message).toMatchObject({ id, type: "synthetic", text: "internal continuation" })
      const context = toLLMMessages([message!], model)
      expect(context.map((item) => item.role)).toEqual(["system", "user"])
      expect(context[0]?.content).toEqual([{ type: "text", text: "historical system" }])
      expect(context[1]?.content).toEqual([{ type: "text", text: "internal continuation" }])
    }),
  )

  it.effect("preserves ordered legacy user text parts and bounded comment metadata", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_text_parts")
      yield* setup(sessionID)
      const messageID = yield* insertUser(sessionID, "structured_user", 10, { text: "visible" })
      const { db } = yield* Database.Service
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.ascending("prt_structured_z"),
          message_id: messageID,
          session_id: sessionID,
          time_created: 11,
          time_updated: 11,
          data: {
            type: "text",
            text: "ignored detail",
            ignored: true,
            metadata: {
              opencodeComment: {
                path: "src/file.ts",
                selection: { startLine: 1, startChar: 2, endLine: 3, endChar: 4 },
                comment: "check this",
                preview: "const value = 1",
                origin: "review",
                untrustedExtra: "retained only in legacy metadata",
              },
            },
          } as typeof PartTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* adopt(sessionID)

      const message = yield* (yield* SessionV2.Service).message({
        sessionID,
        messageID: currentID(messageID),
      })
      expect(message).toMatchObject({
        type: "user",
        text: "visible",
        parts: [
          { id: "prt_structured_user", text: "visible" },
          {
            id: "prt_structured_z",
            text: "ignored detail",
            ignored: true,
            metadata: {
              forgeComment: {
                path: "src/file.ts",
                selection: { startLine: 1, startChar: 2, endLine: 3, endChar: 4 },
                comment: "check this",
                preview: "const value = 1",
                origin: "review",
              },
            },
          },
        ],
        metadata: {
          forge: {
            legacy: {
              textPartMetadata: [
                {
                  id: "prt_structured_z",
                  metadata: {
                    opencodeComment: {
                      untrustedExtra: "retained only in legacy metadata",
                    },
                  },
                },
              ],
            },
          },
        },
      })
    }),
  )

  it.effect("uses adopted negative sequences as real revert boundaries", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_revert")
      const first = SessionV1.MessageID.ascending("msg_revert_first")
      const boundary = SessionV1.MessageID.ascending("msg_revert_boundary")
      yield* setup(sessionID, { messageID: currentID(boundary) })
      yield* insertUser(sessionID, "revert_first", 10, { text: "first" })
      yield* insertUser(sessionID, "revert_boundary", 20, { text: "boundary" })
      yield* insertUser(sessionID, "revert_later", 30, { text: "later" })
      yield* adopt(sessionID)
      const { db } = yield* Database.Service

      yield* (yield* EventV2.Service).publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: SessionMessage.ID.make(boundary),
        timestamp: DateTime.makeUnsafe(40),
      })

      expect(
        (yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)).map((row) => row.id),
      ).toEqual([currentID(first), currentID(boundary)])
    }),
  )

  it.effect("fails closed for malformed, colliding, and overlapping transcripts", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const malformedID = SessionV2.ID.make("ses_adoption_malformed")
      yield* setup(malformedID)
      yield* db
        .insert(MessageTable)
        .values({
          id: SessionV1.MessageID.ascending("msg_malformed"),
          session_id: malformedID,
          time_created: 10,
          time_updated: 10,
          data: { role: "invalid" } as never,
        })
        .run()
        .pipe(Effect.orDie)
      const malformed = yield* adopt(malformedID).pipe(Effect.flip)
      expect(malformed).toMatchObject({
        _tag: "SessionTranscriptAdoption.AdoptionError",
        message: "Legacy message could not be decoded: msg_malformed",
      })

      const collisionID = SessionV2.ID.make("ses_adoption_collision")
      yield* setup(collisionID)
      const collisionMessage = yield* insertUser(collisionID, "collision", 20, { text: "legacy" })
      const current = SessionMessage.User.make({
        id: SessionMessage.ID.make(collisionMessage),
        type: "user",
        text: "different",
        time: { created: DateTime.makeUnsafe(20) },
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(current)
      const { id: currentID, type, ...currentData } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(currentID),
          session_id: collisionID,
          type,
          seq: 0,
          time_created: 20,
          data: currentData,
        })
        .run()
        .pipe(Effect.orDie)
      const collision = yield* adopt(collisionID).pipe(Effect.flip)
      expect(collision).toMatchObject({
        _tag: "SessionTranscriptAdoption.AdoptionError",
        message: `Current message conflicts with legacy adoption: ${collisionMessage}`,
      })

      const overlapID = SessionV2.ID.make("ses_adoption_overlap")
      yield* setup(overlapID)
      yield* insertUser(overlapID, "overlap_legacy", 50, { text: "legacy" })
      const existing = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_overlap_current"),
        type: "user",
        text: "current",
        time: { created: DateTime.makeUnsafe(40) },
      })
      const existingEncoded = Schema.encodeSync(SessionMessage.Message)(existing)
      const { id: existingID, type: existingType, ...existingData } = existingEncoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(existingID),
          session_id: overlapID,
          type: existingType,
          seq: 0,
          time_created: 40,
          data: existingData,
        })
        .run()
        .pipe(Effect.orDie)
      const overlap = yield* adopt(overlapID).pipe(Effect.flip)
      expect(overlap).toMatchObject({
        _tag: "SessionTranscriptAdoption.AdoptionError",
        message: "Current and legacy transcripts overlap and cannot be ordered safely",
      })
    }),
  )

  it.effect("adopts sessions created through the current project layer", () =>
    Effect.gen(function* () {
      const created = yield* (yield* SessionV2.Service).create({ location })
      yield* adopt(created.id)
      expect(yield* (yield* SessionTranscriptAdoption.Service).adopted(created.id)).toBe(true)
    }),
  )
})

test("file-backed reader pools fence concurrent transcript adoption and legacy writes on the primary", async () => {
  await using tmp = await tmpdir()
  const database = Database.layerFromPath(path.join(tmp.path, "adoption.sqlite"))
  const app = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionTranscriptAdoption.node,
      SessionV2.node,
    ]),
    [
      [Database.node, database],
      [ProjectV2.node, project],
      [SessionExecution.node, SessionExecution.noopLayer],
      [SessionLegacyExecution.node, legacy],
    ],
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_adoption_readers")
      yield* setup(sessionID)
      yield* insertUser(sessionID, "adoption_readers", 10, { text: "reader-safe" })
      const { db } = yield* Database.Service
      expect(isWithReplicas(db)).toBe(true)

      const coldSessionID = SessionV2.ID.make("ses_adoption_cold_reader")
      yield* setup(coldSessionID)
      const coldFirstID = yield* insertUser(coldSessionID, "cold_reader_first", 10, { text: "first" })
      const coldSecondID = yield* insertUser(coldSessionID, "cold_reader_second", 20, { text: "second" })
      const session = yield* SessionV2.Service
      const firstPage = yield* session.messages({ sessionID: coldSessionID, order: "asc", limit: 1 })
      const secondPage = yield* session.messages({
        sessionID: coldSessionID,
        order: "asc",
        limit: 1,
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      const admitted = yield* session.prompt({
        sessionID: coldSessionID,
        id: SessionMessage.ID.make("msg_adoption_cold_current"),
        prompt: Prompt.make({ text: "current" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(
        Database.primary(db),
        yield* EventV2.Service,
        coldSessionID,
        Number.MAX_SAFE_INTEGER,
      )
      const thirdPage = yield* session.messages({
        sessionID: coldSessionID,
        order: "asc",
        limit: 1,
        cursor: { id: secondPage[0]!.id, direction: "next" },
      })

      expect(firstPage.map((message) => message.id)).toEqual([currentID(coldFirstID)])
      expect(secondPage.map((message) => message.id)).toEqual([currentID(coldSecondID)])
      expect(thirdPage.map((message) => message.id)).toEqual([admitted.id])

      yield* Effect.all([adopt(sessionID), adopt(sessionID)], { concurrency: "unbounded" })

      expect(
        yield* db
          .select({ state: SessionTranscriptAdoptionTable.state })
          .from(SessionTranscriptAdoptionTable)
          .where(eq(SessionTranscriptAdoptionTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "current" })
      expect(
        yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ seq: -1 })
      expect(
        yield* SessionTranscriptAdoption.assertLegacyWritable(db, sessionID).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBeInstanceOf(SessionTranscriptAdoption.LegacyWriteBlockedError)

      const events = yield* EventV2.Service
      for (const index of Array.from({ length: 12 }, (_, value) => value)) {
        const raceSessionID = SessionV2.ID.make(`ses_adoption_write_race_${index}`)
        const messageID = SessionV1.MessageID.ascending(`msg_adoption_write_race_${index}`)
        yield* setup(raceSessionID)
        const info = SessionV1.User.make({
          id: messageID,
          sessionID: raceSessionID,
          role: "user",
          time: { created: index + 20 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
        })
        const publish = events
          .publish(
            SessionV1.Event.MessageUpdated,
            { sessionID: raceSessionID, info },
            { commit: () => SessionTranscriptAdoption.assertLegacyWritable(db, raceSessionID) },
          )
          .pipe(Effect.exit)
        const adoption = adopt(raceSessionID).pipe(Effect.exit)
        const [published, adopted] = yield* Effect.all(
          [
            index % 2 === 0 ? publish : Effect.yieldNow.pipe(Effect.andThen(publish)),
            index % 2 === 0 ? Effect.yieldNow.pipe(Effect.andThen(adoption)) : adoption,
          ],
          { concurrency: "unbounded" },
        )
        expect(Exit.isSuccess(adopted)).toBe(true)

        const legacyRows = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, raceSessionID))
          .all()
          .pipe(Effect.orDie)
        const currentRows = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, raceSessionID))
          .all()
          .pipe(Effect.orDie)
        expect(
          yield* db
            .select({ state: SessionTranscriptAdoptionTable.state })
            .from(SessionTranscriptAdoptionTable)
            .where(eq(SessionTranscriptAdoptionTable.session_id, raceSessionID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ state: "current" })
        expect(currentRows.map((row) => String(row.id))).toEqual(legacyRows.map((row) => String(row.id)))
        expect(legacyRows).toHaveLength(Exit.isSuccess(published) ? 1 : 0)
        if (Exit.isFailure(published))
          expect(String(published.cause)).toContain("SessionTranscriptAdoption.LegacyWriteBlockedError")
      }
    }).pipe(Effect.provide(app), Effect.scoped),
  )
})
