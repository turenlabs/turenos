export * as SessionTranscriptAdoption from "./transcript-adoption"

import { isDeepStrictEqual } from "node:util"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { and, asc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { RelativePath } from "../schema"
import { SessionV1 } from "../v1/session"
import { SessionLegacyExecution } from "./legacy-execution"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { TextPart, TextPartID, type TextPartMetadata } from "./prompt"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionMessageTable, SessionTable, SessionTranscriptAdoptionTable } from "./sql"

const Version = 1

type DatabaseService = Database.Interface["db"]
type LegacyInfo = typeof SessionV1.Info.Type
type LegacyPart = typeof SessionV1.Part.Type
type LegacyUser = Extract<LegacyInfo, { readonly role: "user" }>
type LegacyAssistant = Extract<LegacyInfo, { readonly role: "assistant" }>
type LegacyFile = Extract<LegacyPart, { readonly type: "file" }>
type LegacyAgent = Extract<LegacyPart, { readonly type: "agent" }>
type LegacyTool = Extract<LegacyPart, { readonly type: "tool" }>
type LegacyCompaction = Extract<LegacyPart, { readonly type: "compaction" }>
type LegacyStepStart = Extract<LegacyPart, { readonly type: "step-start" }>
type LegacyStepFinish = Extract<LegacyPart, { readonly type: "step-finish" }>
type LegacySnapshot = Extract<LegacyPart, { readonly type: "snapshot" }>
type LegacyPatch = Extract<LegacyPart, { readonly type: "patch" }>
type LegacyMessage = {
  readonly info: LegacyInfo
  readonly parts: ReadonlyArray<LegacyPart>
  readonly timeCreated: number
}
type ConvertedMessage = {
  readonly legacyID: string
  readonly message: SessionMessage.Message
}

export class AdoptionError extends Schema.TaggedErrorClass<AdoptionError>()("SessionTranscriptAdoption.AdoptionError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export class LegacyWriteBlockedError extends Error {
  constructor(readonly sessionID: SessionSchema.ID) {
    super(`Legacy transcript writes are disabled after Session V2 adoption began: ${sessionID}`)
    this.name = "SessionTranscriptAdoption.LegacyWriteBlockedError"
  }
}

export interface Interface {
  readonly ensure: (
    session: SessionSchema.Info,
  ) => Effect.Effect<void, AdoptionError | SessionLegacyExecution.QuiescenceUnavailableError>
  readonly adopted: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@forge/SessionTranscriptAdoption") {}

export const assertLegacyWritable = Effect.fn("SessionTranscriptAdoption.assertLegacyWritable")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const primary = isWithReplicas(db) ? db.$primary : db
  const marker = yield* primary
    .select({ state: SessionTranscriptAdoptionTable.state })
    .from(SessionTranscriptAdoptionTable)
    .where(eq(SessionTranscriptAdoptionTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (marker) return yield* Effect.die(new LegacyWriteBlockedError(sessionID))
})

/**
 * Records a Session as already adopted without running a conversion.
 *
 * For a transcript that was born in V2 — a fork of a V2 transcript, say — there is
 * no legacy predecessor to convert, and leaving the marker off would let `ensure`
 * later attempt an adoption against rows it did not write.
 */
export const markCurrent = Effect.fn("SessionTranscriptAdoption.markCurrent")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const now = Date.now()
  yield* (isWithReplicas(db) ? db.$primary : db)
    .insert(SessionTranscriptAdoptionTable)
    .values({
      session_id: sessionID,
      state: "current",
      version: Version,
      time_started: now,
      time_completed: now,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const primary = isWithReplicas(db) ? db.$primary : db
    const legacy = yield* SessionLegacyExecution.Service

    const adopted = Effect.fn("SessionTranscriptAdoption.adopted")(function* (sessionID: SessionSchema.ID) {
      const row = yield* primary
        .select({ state: SessionTranscriptAdoptionTable.state, version: SessionTranscriptAdoptionTable.version })
        .from(SessionTranscriptAdoptionTable)
        .where(eq(SessionTranscriptAdoptionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row?.state === "current" && row.version === Version
    })

    const ensure = Effect.fn("SessionTranscriptAdoption.ensure")(function* (session: SessionSchema.Info) {
      if (yield* adopted(session.id)) return
      const started = Date.now()
      yield* primary
        .transaction(
          () =>
            primary
              .insert(SessionTranscriptAdoptionTable)
              .values({
                session_id: session.id,
                state: "adopting",
                version: Version,
                time_started: started,
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

      const count = yield* primary.$count(MessageTable, eq(MessageTable.session_id, session.id)).pipe(Effect.orDie)
      yield* legacy.quiesce({ session, hasLegacyTranscript: count > 0 })
      yield* primary
        .transaction(() => adopt(primary, session.id), { behavior: "immediate" })
        .pipe(
          Effect.mapError((error) =>
            Schema.is(AdoptionError)(error)
              ? error
              : new AdoptionError({
                  sessionID: session.id,
                  message: "Transcript adoption transaction failed",
                }),
          ),
        )
    })

    return Service.of({ ensure, adopted })
  }),
)

const adopt = Effect.fn("SessionTranscriptAdoption.convert")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const marker = yield* db
    .select()
    .from(SessionTranscriptAdoptionTable)
    .where(eq(SessionTranscriptAdoptionTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (marker?.state === "current" && marker.version === Version) return
  if (!marker)
    return yield* new AdoptionError({
      sessionID,
      message: "Transcript adoption marker disappeared before conversion",
    })

  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)
  const partRows = yield* db
    .select()
    .from(PartTable)
    .where(eq(PartTable.session_id, sessionID))
    .orderBy(asc(PartTable.message_id), asc(PartTable.id))
    .all()
    .pipe(Effect.orDie)
  const grouped = new Map<string, LegacyPart[]>()

  for (const row of partRows) {
    const decoded = Schema.decodeUnknownOption(SessionV1.Part)({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
    })
    if (Option.isNone(decoded))
      return yield* new AdoptionError({
        sessionID,
        message: `Legacy part could not be decoded: ${row.id}`,
      })
    const list = grouped.get(row.message_id)
    if (list) list.push(decoded.value)
    else grouped.set(row.message_id, [decoded.value])
  }

  const legacy = yield* Effect.forEach(rows, (row) => {
    const decoded = Schema.decodeUnknownOption(SessionV1.Info)({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
    })
    if (Option.isNone(decoded))
      return Effect.fail(
        new AdoptionError({
          sessionID,
          message: `Legacy message could not be decoded: ${row.id}`,
        }),
      )
    return Effect.succeed({
      info: decoded.value,
      parts: grouped.get(row.id) ?? [],
      timeCreated: row.time_created,
    } satisfies LegacyMessage)
  })
  const incompatible = legacy.find((message) => !Schema.is(SessionMessage.ID)(message.info.id))
  if (incompatible)
    return yield* new AdoptionError({
      sessionID,
      message: `Legacy message ID is incompatible with Session V2: ${incompatible.info.id}`,
    })
  const unrepresentable = legacy.flatMap((message) => {
    if (message.info.role !== "user") return []
    const parts = message.parts.filter((part): part is SessionV1.TextPart => part.type === "text")
    if (parts.length > 256) return [`Legacy user message has too many text parts: ${message.info.id}`]
    const invalid = parts.find((part) => part.id.length > 128 || part.text.length > 1_000_000)
    return invalid ? [`Legacy text part exceeds Session V2 bounds: ${invalid.id}`] : []
  })[0]
  if (unrepresentable)
    return yield* new AdoptionError({
      sessionID,
      message: unrepresentable,
    })
  const converted = convertMessages(legacy)
  const seenMessageIDs = new Set<string>()
  const duplicate = converted.find((item) => {
    if (seenMessageIDs.has(item.message.id)) return true
    seenMessageIDs.add(item.message.id)
    return false
  })
  if (duplicate)
    return yield* new AdoptionError({
      sessionID,
      message: `Legacy message IDs collide after normalization: ${duplicate.legacyID}`,
    })

  const current = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const expected = converted.map((item, index) => ({
    ...encode(item.message),
    legacyID: item.legacyID,
    seq: index - converted.length,
  }))
  const byID = new Map(current.map((row) => [row.id, row]))
  const bySeq = new Map(current.map((row) => [row.seq, row]))
  const exact = new Set<string>()

  for (const item of expected) {
    const id = byID.get(item.id)
    if (id) {
      if (
        id.seq !== item.seq ||
        id.type !== item.type ||
        id.time_created !== item.timeCreated ||
        !isDeepStrictEqual(id.data, item.data)
      )
        return yield* new AdoptionError({
          sessionID,
          message: `Current message conflicts with legacy adoption: ${item.id}`,
        })
      exact.add(item.id)
      continue
    }
    const seq = bySeq.get(item.seq)
    if (seq)
      return yield* new AdoptionError({
        sessionID,
        message: `Current message sequence conflicts with legacy adoption: ${item.seq}`,
      })
  }

  const remaining = current.filter((row) => !exact.has(row.id))
  const maxLegacyTime = rows.at(-1)?.time_created
  if (remaining.some((row) => row.seq < 0 || (maxLegacyTime !== undefined && row.time_created < maxLegacyTime)))
    return yield* new AdoptionError({
      sessionID,
      message: "Current and legacy transcripts overlap and cannot be ordered safely",
    })

  for (const item of expected) {
    const identity = yield* SessionInput.findIdentity(db, item.id)
    if (
      identity &&
      (identity.owner !== "message" ||
        identity.kind !== "message" ||
        identity.sessionID !== sessionID ||
        identity.state !== "active")
    )
      return yield* new AdoptionError({
        sessionID,
        message: `Current message identity conflicts with legacy adoption: ${item.id}`,
      })
    if (!identity)
      yield* SessionInput.projectMessageIdentity(db, {
        id: item.id,
        sessionID,
        kind: "message",
        creatorSeq: item.seq,
        timeCreated: DateTime.makeUnsafe(item.timeCreated),
      })
    if (exact.has(item.id)) continue
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: item.id,
        session_id: sessionID,
        type: item.type,
        seq: item.seq,
        time_created: item.timeCreated,
        data: item.data,
      })
      .run()
      .pipe(Effect.orDie)
  }

  const session = yield* db
    .select({ revert: SessionTable.revert })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (session?.revert) {
    const mapped = expected.find((item) => item.legacyID === session.revert?.messageID)
    if (mapped && mapped.id !== session.revert.messageID)
      yield* db
        .update(SessionTable)
        .set({ revert: { ...session.revert, messageID: SessionMessage.ID.make(mapped.id) } })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
  }

  const completed = yield* db
    .update(SessionTranscriptAdoptionTable)
    .set({ state: "current", version: Version, time_completed: Date.now() })
    .where(
      and(
        eq(SessionTranscriptAdoptionTable.session_id, sessionID),
        eq(SessionTranscriptAdoptionTable.state, "adopting"),
      ),
    )
    .returning({ sessionID: SessionTranscriptAdoptionTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!completed)
    return yield* new AdoptionError({
      sessionID,
      message: "Transcript adoption marker did not transition to current",
    })
})

function convertMessages(messages: ReadonlyArray<LegacyMessage>): ConvertedMessage[] {
  const byID = new Map(messages.map((message) => [message.info.id, message]))
  const completedCompactions = new Map(
    messages.flatMap((message) => {
      if (message.info.role !== "assistant" || !message.info.summary || !message.info.finish || message.info.error)
        return []
      const parent = byID.get(message.info.parentID)
      if (!parent || parent.info.role !== "user") return []
      const part = parent.parts.find((candidate): candidate is LegacyCompaction => candidate.type === "compaction")
      return part ? [[message.info.id, { parent, part }] as const] : []
    }),
  )

  return messages.map((message) => {
    const compaction = completedCompactions.get(message.info.id)
    return {
      legacyID: message.info.id,
      message: compaction ? convertCompaction(messages, message, compaction.parent, compaction.part) : convert(message),
    }
  })
}

function convert(message: LegacyMessage): SessionMessage.Message {
  if (message.info.role === "user") {
    const user = { ...message, info: message.info }
    if (synthetic(user)) return convertSynthetic(user)
    return convertUser(user)
  }
  return convertAssistant({ ...message, info: message.info })
}

function synthetic(message: LegacyMessage & { readonly info: LegacyUser }) {
  if (message.parts.some((part) => part.type === "compaction")) return true
  if (message.parts.some((part) => part.type === "file" || part.type === "agent")) return false
  const text = message.parts.filter((part) => part.type === "text")
  return text.length > 0 && text.every((part) => part.synthetic === true)
}

function convertSynthetic(message: LegacyMessage & { readonly info: LegacyUser }): SessionMessage.Synthetic {
  return SessionMessage.Synthetic.make({
    id: messageID(message.info.id),
    sessionID: SessionSchema.ID.make(message.info.sessionID),
    type: "synthetic",
    text: message.parts
      .flatMap((part) => {
        if (part.type === "text" && !part.ignored) return [part.text]
        if (part.type === "compaction") return ["What did we do so far?"]
        if (part.type === "subtask") return ["The following tool was executed by the user"]
        return []
      })
      .filter((value) => value.length > 0)
      .join("\n"),
    metadata: metadata(message),
    time: { created: DateTime.makeUnsafe(message.timeCreated) },
  })
}

function convertUser(message: LegacyMessage & { readonly info: LegacyUser }): SessionMessage.User {
  const parts = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) =>
      TextPart.make({
        id: TextPartID.make(part.id),
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
        metadata: textPartMetadata(part.metadata),
      }),
    )
  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text" && !part.ignored) return [part.text]
      if (part.type === "compaction") return ["What did we do so far?"]
      if (part.type === "subtask") return ["The following tool was executed by the user"]
      return []
    })
    .filter((value) => value.length > 0)
    .join("\n")
  const files = message.parts.filter((part): part is LegacyFile => part.type === "file").map(file)
  const agents = message.parts
    .filter((part): part is LegacyAgent => part.type === "agent")
    .map((part) => ({
      name: part.name,
      source: part.source
        ? {
            text: part.source.value,
            start: part.source.start,
            end: part.source.end,
          }
        : undefined,
    }))
  return SessionMessage.User.make({
    id: messageID(message.info.id),
    type: "user",
    text,
    parts: parts.length > 0 ? parts : undefined,
    files: files.length > 0 ? files : undefined,
    agents: agents.length > 0 ? agents : undefined,
    metadata: metadata(message),
    time: { created: DateTime.makeUnsafe(message.timeCreated) },
  })
}

function convertAssistant(message: LegacyMessage & { readonly info: LegacyAssistant }): SessionMessage.Assistant {
  const stepStart = message.parts.findLast((part): part is LegacyStepStart => part.type === "step-start")
  const stepFinish = message.parts.findLast((part): part is LegacyStepFinish => part.type === "step-finish")
  const snapshot = message.parts.findLast((part): part is LegacySnapshot => part.type === "snapshot")
  const patch = message.parts.findLast((part): part is LegacyPatch => part.type === "patch")
  const files = patch?.files
    .map((path) => Schema.decodeUnknownOption(RelativePath)(path))
    .filter(Option.isSome)
    .map((path) => path.value)
  const content = message.parts.flatMap((part): SessionMessage.AssistantContent[] => {
    if (part.type === "text") return [SessionMessage.AssistantText.make({ type: "text", id: part.id, text: part.text })]
    if (part.type === "reasoning")
      return [
        SessionMessage.AssistantReasoning.make({
          type: "reasoning",
          id: part.id,
          text: part.text,
          providerMetadata: providerMetadata(part.metadata),
          time: {
            created: DateTime.makeUnsafe(part.time.start),
            completed: part.time.end === undefined ? undefined : DateTime.makeUnsafe(part.time.end),
          },
        }),
      ]
    if (part.type === "tool") return [tool(part, message.timeCreated)]
    return []
  })
  const error = message.info.error
    ? SessionMessage.UnknownError.make({
        type: "unknown",
        message: errorMessage(message.info.error),
      })
    : undefined
  return SessionMessage.Assistant.make({
    id: messageID(message.info.id),
    type: "assistant",
    agent: AgentV2.ID.make(message.info.agent),
    model: {
      providerID: ProviderV2.ID.make(message.info.providerID),
      id: ModelV2.ID.make(message.info.modelID),
      variant: ModelV2.VariantID.make(message.info.variant ?? "default"),
    },
    content,
    snapshot:
      stepStart?.snapshot || snapshot?.snapshot || stepFinish?.snapshot || files?.length
        ? {
            start: stepStart?.snapshot ?? snapshot?.snapshot,
            end: stepFinish?.snapshot,
            files: files?.length ? files : undefined,
          }
        : undefined,
    finish: stepFinish?.reason ?? message.info.finish,
    cost: stepFinish?.cost ?? message.info.cost,
    tokens: stepFinish?.tokens ?? message.info.tokens,
    error,
    metadata: metadata(message),
    time: {
      created: DateTime.makeUnsafe(message.timeCreated),
      completed:
        message.info.time.completed === undefined ? undefined : DateTime.makeUnsafe(message.info.time.completed),
    },
  })
}

function convertCompaction(
  messages: ReadonlyArray<LegacyMessage>,
  summary: LegacyMessage,
  parent: LegacyMessage,
  part: LegacyCompaction,
): SessionMessage.Compaction {
  const start = part.tail_start_id ? messages.findIndex((message) => message.info.id === part.tail_start_id) : -1
  const end = messages.findIndex((message) => message.info.id === parent.info.id)
  const recent =
    start >= 0 && end > start
      ? messages
          .slice(start, end)
          .map(evidence)
          .filter((value) => value.length > 0)
          .join("\n\n")
      : ""
  return SessionMessage.Compaction.make({
    id: messageID(summary.info.id),
    type: "compaction",
    reason: part.auto ? "auto" : "manual",
    summary: summary.parts
      .filter((candidate): candidate is SessionV1.TextPart => candidate.type === "text")
      .map((candidate) => candidate.text)
      .join("\n\n"),
    recent,
    metadata: metadata(summary),
    time: { created: DateTime.makeUnsafe(summary.timeCreated) },
  })
}

function evidence(message: LegacyMessage) {
  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "reasoning") return [`[Reasoning] ${part.text}`]
      if (part.type === "tool" && part.state.status === "completed") return [`[Tool ${part.tool}] ${part.state.output}`]
      if (part.type === "tool" && part.state.status === "error")
        return [`[Tool ${part.tool} error] ${part.state.error}`]
      return []
    })
    .filter((value) => value.length > 0)
    .join("\n")
  return text.length > 0 ? `[${message.info.role === "user" ? "User" : "Assistant"}]\n${text}` : ""
}

function tool(part: LegacyTool, fallbackTime: number): SessionMessage.AssistantTool {
  const executed = part.metadata?.providerExecuted === true
  const provider =
    executed || providerMetadata(part.metadata)
      ? {
          executed,
          metadata: providerMetadata(part.metadata),
        }
      : undefined
  if (part.state.status === "pending")
    return SessionMessage.AssistantTool.make({
      type: "tool",
      id: part.callID,
      name: part.tool,
      provider,
      state: SessionMessage.ToolStatePending.make({ status: "pending", input: part.state.raw }),
      time: { created: DateTime.makeUnsafe(fallbackTime) },
    })
  if (part.state.status === "running")
    return SessionMessage.AssistantTool.make({
      type: "tool",
      id: part.callID,
      name: part.tool,
      provider,
      state: SessionMessage.ToolStateError.make({
        status: "error",
        input: part.state.input,
        content: textContent(part.state.metadata?.output),
        structured: structured(part.state),
        error: { type: "unknown", message: "Tool execution was interrupted during Session V2 adoption" },
      }),
      time: {
        created: DateTime.makeUnsafe(fallbackTime),
        ran: DateTime.makeUnsafe(part.state.time.start),
        completed: DateTime.makeUnsafe(part.state.time.start),
      },
    })
  if (part.state.status === "error")
    return SessionMessage.AssistantTool.make({
      type: "tool",
      id: part.callID,
      name: part.tool,
      provider,
      state: SessionMessage.ToolStateError.make({
        status: "error",
        input: part.state.input,
        content: textContent(part.state.metadata?.output),
        structured: structured(part.state),
        error: { type: "unknown", message: part.state.error },
      }),
      time: {
        created: DateTime.makeUnsafe(fallbackTime),
        ran: DateTime.makeUnsafe(part.state.time.start),
        completed: DateTime.makeUnsafe(part.state.time.end),
      },
    })
  const attachments = part.state.attachments?.map(file)
  return SessionMessage.AssistantTool.make({
    type: "tool",
    id: part.callID,
    name: part.tool,
    provider,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: part.state.input,
      attachments,
      content: [
        { type: "text", text: part.state.output },
        ...(attachments ?? []).map((attachment) => ({
          type: "file" as const,
          uri: attachment.uri,
          mime: attachment.mime,
          name: attachment.name,
        })),
      ],
      structured: structured(part.state),
      result: executed ? part.state.output : undefined,
    }),
    time: {
      created: DateTime.makeUnsafe(fallbackTime),
      ran: DateTime.makeUnsafe(part.state.time.start),
      completed: DateTime.makeUnsafe(part.state.time.end),
      pruned: part.state.time.compacted === undefined ? undefined : DateTime.makeUnsafe(part.state.time.compacted),
    },
  })
}

function file(part: LegacyFile) {
  return {
    uri: part.url,
    mime: part.mime,
    name: part.filename,
    source: part.source
      ? {
          text: part.source.text.value,
          start: part.source.text.start,
          end: part.source.text.end,
        }
      : undefined,
  }
}

function metadata(message: LegacyMessage): Record<string, unknown> {
  return {
    forge: {
      legacy: {
        role: message.info.role,
        ...(message.info.role === "user"
          ? {
              system: message.info.system,
              tools: message.info.tools,
              format: message.info.format,
              summary: message.info.summary,
            }
          : {
              parentID: message.info.parentID,
              mode: message.info.mode,
              path: message.info.path,
              summary: message.info.summary,
              structured: message.info.structured,
              error: message.info.error,
            }),
        unsupportedParts: message.parts.filter(
          (part) => !["text", "reasoning", "tool", "file", "agent", "step-start", "step-finish"].includes(part.type),
        ),
        textPartMetadata: message.parts.flatMap((part) =>
          part.type === "text" && part.metadata !== undefined ? [{ id: part.id, metadata: part.metadata }] : [],
        ),
      },
    },
  }
}

function textPartMetadata(input: Record<string, unknown> | undefined): TextPartMetadata | undefined {
  const metadata = input?.forgeComment ?? input?.opencodeComment
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const value = metadata as Record<string, unknown>
  if (
    typeof value.path !== "string" ||
    value.path.length > 4_096 ||
    typeof value.comment !== "string" ||
    value.comment.length > 100_000
  )
    return undefined
  const preview = typeof value.preview === "string" && value.preview.length <= 100_000 ? value.preview : undefined
  const origin: "review" | "file" | undefined =
    value.origin === "review" ? "review" : value.origin === "file" ? "file" : undefined
  const rawSelection = value.selection
  const selection =
    rawSelection &&
    typeof rawSelection === "object" &&
    !Array.isArray(rawSelection) &&
    ["startLine", "startChar", "endLine", "endChar"].every((key) => {
      const part = (rawSelection as Record<string, unknown>)[key]
      return Number.isSafeInteger(part) && Number(part) >= 0
    })
      ? {
          startLine: Number((rawSelection as Record<string, unknown>).startLine),
          startChar: Number((rawSelection as Record<string, unknown>).startChar),
          endLine: Number((rawSelection as Record<string, unknown>).endLine),
          endChar: Number((rawSelection as Record<string, unknown>).endChar),
        }
      : undefined
  return {
    forgeComment: {
      path: value.path,
      selection,
      comment: value.comment,
      preview,
      origin,
    },
  }
}

function providerMetadata(input: Record<string, unknown> | undefined) {
  if (!input) return undefined
  const entries = Object.entries(input).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      entry[0] !== "providerExecuted" && typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function structured(input: object) {
  return { legacy: input } as Record<string, unknown>
}

function textContent(input: unknown) {
  return typeof input === "string" && input.length > 0 ? [{ type: "text" as const, text: input }] : []
}

function errorMessage(error: NonNullable<LegacyAssistant["error"]>) {
  const data = error.data as Record<string, unknown>
  return typeof data.message === "string" ? data.message : error.name
}

function messageID(id: string) {
  return SessionMessage.ID.make(id)
}

function encode(message: SessionMessage.Message) {
  const value = Schema.encodeSync(SessionMessage.Message)(message)
  const { id, type, ...data } = value
  return {
    id: SessionMessage.ID.make(id),
    type,
    timeCreated: DateTime.toEpochMillis(message.time.created),
    data,
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionLegacyExecution.node],
})
