export * as Reflection from "./reflection"

import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { Config } from "./config"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionMessage } from "./session/message"
import { NonNegativeInt } from "./schema"
import { SessionSchema } from "./session/schema"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { fromRow } from "./session/info"
import { Storage } from "./storage"
import { SessionV1 } from "./v1/session"
import { and, desc, eq } from "drizzle-orm"

const SCOPE = Storage.Scope.make("internal/reflection")
export const DEFAULT_INTERVAL = 20
const MAX_SUMMARY_LENGTH = 4_000
const MAX_ITEM_LENGTH = 2_000
const MAX_ITEMS = 24
const CLAIM_TIMEOUT_MS = 60 * 60 * 1_000
const SYNTHETIC_PREFIXES = ["ses_handoff_", "ses_loop_", "ses_pentest_"]
const bounded = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(MAX_ITEM_LENGTH)))
const boundedItems = Schema.Array(bounded).pipe(Schema.check(Schema.isMaxLength(MAX_ITEMS)))
export const Lesson = Schema.Struct({
  lesson: bounded,
  evidence: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_ITEM_LENGTH)), Schema.optional),
})
const boundedLessons = Schema.Array(Schema.Union([bounded, Lesson])).pipe(Schema.check(Schema.isMaxLength(MAX_ITEMS)))

export const HypothesisStatus = Schema.Literals(["open", "supported", "rejected", "inconclusive"])
export type HypothesisStatus = typeof HypothesisStatus.Type

export const Hypothesis = Schema.Struct({
  claim: bounded,
  status: HypothesisStatus,
  evidence: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_ITEM_LENGTH)), Schema.optional),
})
export type Hypothesis = typeof Hypothesis.Type

export const WorkState = Schema.Struct({
  prediction: bounded,
  hypotheses: Schema.Array(Hypothesis).pipe(Schema.check(Schema.isMaxLength(MAX_ITEMS))),
  nextAction: bounded,
  updatedAt: NonNegativeInt,
})
export type WorkState = typeof WorkState.Type

export const ReflectionInput = Schema.Struct({
  critique: bounded,
  lessons: boundedLessons,
  memories: boundedItems,
})
export type ReflectionInput = typeof ReflectionInput.Type

const CadenceState = Schema.Struct({
  completed: NonNegativeInt,
  reflected: NonNegativeInt,
  pending: Schema.Boolean,
  claimedBy: SessionSchema.ID.pipe(Schema.optional),
  claimedAt: NonNegativeInt.pipe(Schema.optional),
  claimedThrough: NonNegativeInt.pipe(Schema.optional),
  claimedInterval: NonNegativeInt.pipe(Schema.optional),
  activationCompletionID: SessionMessage.ID.pipe(Schema.optional),
})
type CadenceState = typeof CadenceState.Type

const initialCadenceState = (): CadenceState => ({ completed: 0, reflected: 0, pending: false })
const decodeCadenceState = Schema.decodeUnknownOption(Schema.fromJsonString(CadenceState))
const Completion = Schema.Struct({ sessionID: SessionSchema.ID })
const decodeCompletion = Schema.decodeUnknownOption(Schema.fromJsonString(Completion))

export const GUIDANCE = [
  "Embedded work discipline:",
  "- Before a non-trivial action with an uncertain outcome, call reflection_state with a concise prediction, explicit hypotheses, and the next action.",
  "- Use reflection_read when a prior prediction may already exist, especially after compaction, interruption, or resuming a Session.",
  "- Treat assumptions as open hypotheses. After tool, test, build, or user results arrive, update each relevant hypothesis to supported, rejected, or inconclusive and cite that external evidence.",
  "- Do not claim success while a material hypothesis remains open. Verify the final result against an authoritative external result, not only your own implementation or reasoning.",
  "- Before implementing, apply this decision ladder in order:",
  "  1. Does this need to exist? If not, skip it (YAGNI).",
  "  2. Does this codebase already do it? Reuse it; do not rewrite it.",
  "  3. Does the standard library do it? Use it.",
  "  4. Does the native platform do it? Use it.",
  "  5. Does an installed dependency do it? Use it.",
  "  6. Is it one line? Keep it one line.",
  "  7. Only then, implement the minimum that works.",
  "- Optimize for practical reliability, not exhaustive certainty. Resolve confirmed material risks, time-box speculative edge-case hunting, and do not let low-probability concerns prevent delivering a verified useful result.",
  "- The work state is durable but session-scoped. Use durable project memory separately for stable cross-session lessons.",
].join("\n")

export const CHECKPOINT_RULES = [
  "Reflection rules:",
  "- Treat the current path as provisional. If it no longer supports the objective, stop and pivot now; do not preserve sunk cost.",
  "- Re-derive the problem from first principles and test the prompt's assumptions. User prompts can omit important constraints or contain low-quality shortcuts.",
  "- Optimize for a correct, well-reasoned outcome, not the fastest apparent completion. Consider material tradeoffs, alternatives, risks, and reversibility before choosing.",
  "- Prefer the smallest correct change and established design patterns. Avoid unnecessary code and abstraction, but never sacrifice correctness, clarity, or maintainability merely to reduce line count.",
].join("\n")

export function reflectionSettings(entries: readonly Config.Entry[]) {
  const configured = Config.latest(entries, "reflection")
  return { enabled: configured?.enabled, interval: configured?.every_sessions }
}

export function isEligible(session: SessionSchema.Info) {
  return session.parentID === undefined && !SYNTHETIC_PREFIXES.some((prefix) => session.id.startsWith(prefix))
}

export interface Interface {
  readonly work: (sessionID: SessionSchema.ID) => Effect.Effect<WorkState | undefined>
  readonly updateWork: (sessionID: SessionSchema.ID, state: Omit<WorkState, "updatedAt">) => Effect.Effect<WorkState>
  readonly recordCompletion: (
    input: Settings & { readonly session: SessionSchema.Info; readonly completionID?: string },
  ) => Effect.Effect<boolean>
  readonly reconcile: (input: Settings & { readonly session: SessionSchema.Info }) => Effect.Effect<number>
  readonly due: (input: Settings & { readonly session: SessionSchema.Info }) => Effect.Effect<boolean>
  readonly prompt: (
    input: Settings & { readonly session: SessionSchema.Info; readonly claim?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly complete: (session: SessionSchema.Info, input: ReflectionInput) => Effect.Effect<boolean>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly resetPending: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly resetComplete: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export interface Settings {
  readonly enabled?: boolean
  readonly interval?: number
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Reflection") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const db = Database.primary((yield* Database.Service).db)
    const events = yield* EventV2.Service
    const scope = yield* Effect.scope

    const cadenceAddress = (sessionID: SessionSchema.ID) => ({
      scope: SCOPE,
      key: Storage.Key.make(`session/${sessionID}/cadence`),
    })
    const workAddress = (sessionID: SessionSchema.ID) => ({
      scope: SCOPE,
      key: Storage.Key.make(`session/${sessionID}/work`),
    })
    const reflectionAddress = (sessionID: SessionSchema.ID) => ({
      scope: SCOPE,
      key: Storage.Key.make(`session/${sessionID}/last`),
    })
    const completionAddress = (sessionID: SessionSchema.ID, completionID: string) => ({
      scope: SCOPE,
      key: Storage.Key.make(`session/${sessionID}/completed/${completionID}`),
    })
    const remove = Effect.fn("Reflection.remove")(function* (sessionID: SessionSchema.ID) {
      const prefix = `session/${sessionID}/`
      while (true) {
        const entries = yield* storage.query({ scope: SCOPE, prefix, limit: 1_000 })
        if (entries.length === 0) return
        yield* storage.batch({
          sets: [],
          removes: entries.map((entry) => ({ scope: SCOPE, key: entry.key })),
        })
      }
    })
    const readCadence = Effect.fn("Reflection.readCadence")(function* (sessionID: SessionSchema.ID) {
      const stored = yield* storage.get(cadenceAddress(sessionID))
      if (!stored) return { value: initialCadenceState(), revision: null }
      const decoded = decodeCadenceState(stored.value)
      return {
        value: Option.isSome(decoded) ? decoded.value : initialCadenceState(),
        revision: stored.revision,
      }
    })
    const updateCadence = Effect.fn("Reflection.updateCadence")(function* (
      sessionID: SessionSchema.ID,
      update: (current: CadenceState) => CadenceState,
    ) {
      while (true) {
        const current = yield* readCadence(sessionID)
        const value = update(current.value)
        const saved = yield* storage
          .compareAndSwap({
            ...cadenceAddress(sessionID),
            value: JSON.stringify(value),
            expectedRevision: current.revision,
          })
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("Storage.RevisionConflict", () => Effect.succeed(Option.none())),
          )
        if (Option.isSome(saved)) return value
      }
    })
    const activateCadence = Effect.fn("Reflection.activateCadence")(function* (
      sessionID: SessionSchema.ID,
      activationCompletionID?: SessionMessage.ID,
    ) {
      while (true) {
        const current = yield* readCadence(sessionID)
        if (current.revision !== null) return false
        const activated = yield* storage
          .compareAndSwap({
            ...cadenceAddress(sessionID),
            value: JSON.stringify({ ...initialCadenceState(), activationCompletionID }),
            expectedRevision: null,
          })
          .pipe(
            Effect.as(true),
            Effect.catchTag("Storage.RevisionConflict", () => Effect.succeed(false)),
          )
        if (activated) return true
      }
    })
    const claim = Effect.fn("Reflection.claim")(function* (session: SessionSchema.Info, interval: number) {
      const now = Date.now()
      const next = yield* updateCadence(session.id, (current) => {
        if (!current.pending) return current
        if (
          current.claimedBy !== undefined &&
          current.claimedBy !== session.id &&
          current.claimedAt !== undefined &&
          now - current.claimedAt < CLAIM_TIMEOUT_MS
        )
          return current
        return {
          ...current,
          claimedBy: session.id,
          claimedAt: now,
          claimedThrough: current.completed,
          claimedInterval: interval,
        }
      })
      return next.pending && next.claimedBy === session.id
    })

    const recordCompletion = Effect.fn("Reflection.recordCompletion")(function* (input: {
      readonly session: SessionSchema.Info
      readonly completionID?: string
      readonly enabled?: boolean
      readonly interval?: number
    }) {
      const session = input.session
      if (!isEligible(session)) return false
      if (input.enabled === false) return false
      const completion = completionAddress(session.id, input.completionID ?? session.id)
      while (true) {
        const counted = yield* storage.get(completion)
        if (counted) {
          const decoded = decodeCompletion(counted.value)
          if (Option.isSome(decoded) && decoded.value.sessionID === session.id)
            return (yield* readCadence(session.id)).value.pending
          yield* storage.remove(completion)
          continue
        }
        const current = yield* readCadence(session.id)
        const completed = current.value.completed + 1
        const value = {
          ...current.value,
          completed,
          pending:
            current.value.pending ||
            completed - current.value.reflected >= Math.max(1, input.interval ?? DEFAULT_INTERVAL),
        }
        const saved = yield* storage
          .guardedBatch({
            guards: [
              { ...cadenceAddress(session.id), expectedRevision: current.revision },
              { ...completion, expectedRevision: null },
            ],
            sets: [
              { ...cadenceAddress(session.id), value: JSON.stringify(value) },
              { ...completion, value: JSON.stringify({ sessionID: session.id }) },
            ],
            removes: [],
          })
          .pipe(
            Effect.as(true),
            Effect.catchTag("Storage.RevisionConflict", () => Effect.succeed(false)),
          )
        if (saved) return value.pending
      }
    })

    yield* events.subscribe(SessionV1.Event.Deleted).pipe(
      Stream.runForEach((event) => remove(event.data.sessionID)),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    return Service.of({
      work: Effect.fn("Reflection.work")(function* (sessionID) {
        const stored = yield* storage.get(workAddress(sessionID))
        if (!stored) return
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WorkState))(stored.value)
        return Option.getOrUndefined(decoded)
      }),
      updateWork: Effect.fn("Reflection.updateWork")(function* (sessionID, state) {
        const value: WorkState = { ...state, updatedAt: Date.now() }
        yield* storage.set({ ...workAddress(sessionID), value: JSON.stringify(value) })
        return value
      }),
      recordCompletion,
      reconcile: Effect.fn("Reflection.reconcile")(function* (input) {
        if (input.enabled === false || !isEligible(input.session)) return 0
        const row = yield* db
          .select({ session: SessionTable, assistant: SessionMessageTable })
          .from(SessionTable)
          .innerJoin(SessionMessageTable, eq(SessionMessageTable.session_id, SessionTable.id))
          .where(and(eq(SessionTable.id, input.session.id), eq(SessionMessageTable.type, "assistant")))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const activationCompletionID = row ? SessionMessage.ID.make(row.assistant.id) : undefined
        if (yield* activateCadence(input.session.id, activationCompletionID)) return 0
        if (!row) return 0
        const assistant = Schema.decodeUnknownOption(SessionMessage.Assistant)({
          ...row.assistant.data,
          id: row.assistant.id,
          type: "assistant",
        })
        if (Option.isNone(assistant) || assistant.value.time.completed === undefined || assistant.value.error) return 0
        if ((yield* readCadence(input.session.id)).value.activationCompletionID === assistant.value.id) return 0
        yield* recordCompletion({
          session: fromRow(row.session),
          completionID: assistant.value.id,
          enabled: input.enabled,
          interval: input.interval,
        })
        return 1
      }),
      due: Effect.fn("Reflection.due")(function* (input) {
        if (input.enabled === false || !isEligible(input.session)) return false
        const state = (yield* readCadence(input.session.id)).value
        return (
          state.pending &&
          (state.claimedBy === undefined ||
            state.claimedBy === input.session.id ||
            state.claimedAt === undefined ||
            Date.now() - state.claimedAt >= CLAIM_TIMEOUT_MS)
        )
      }),
      prompt: Effect.fn("Reflection.prompt")(function* (input) {
        if (input.enabled === false) return
        if (!isEligible(input.session)) return
        if (input.claim === false) return
        const configuredInterval = Math.max(1, input.interval ?? DEFAULT_INTERVAL)
        const checkpoint = input.session.parentID === undefined && (yield* claim(input.session, configuredInterval))
        if (!checkpoint) return
        const cadence = (yield* readCadence(input.session.id)).value
        const completedTurns = (cadence.claimedThrough ?? cadence.completed) - cadence.reflected
        return [
          "<reflection_checkpoint>",
          "This is an embedded TurenOS self-reflection pass, not a user request and not a separate supervisor.",
          `It is due after ${completedTurns} completed ${completedTurns === 1 ? "turn" : "turns"} in this session.`,
          "Before further substantive work, compare prior predictions and hypotheses with external results, identify one evidenced mistake, blind spot, or process improvement, and search relevant project memory.",
          CHECKPOINT_RULES,
          "Write only stable cross-session lessons through memory_write. Do not store routine progress, secrets, or facts already maintained in source control.",
          "Call reflection_complete exactly once after the critique. Pass lessons as concise strings or {lesson, evidence} objects, and pass memories as the titles of memories written. Do not narrate this checkpoint to the user; then continue the newest user instruction.",
          "</reflection_checkpoint>",
        ].join("\n")
      }),
      complete: Effect.fn("Reflection.complete")(function* (session, input) {
        if (session.parentID !== undefined) return false
        while (true) {
          const current = yield* readCadence(session.id)
          if (!current.value.pending || current.value.claimedBy !== session.id) return false
          const reflected = current.value.claimedThrough ?? current.value.reflected
          const cadence: CadenceState = {
            completed: current.value.completed,
            reflected,
            pending: current.value.completed - reflected >= (current.value.claimedInterval ?? DEFAULT_INTERVAL),
          }
          const saved = yield* storage
            .guardedBatch({
              guards: [{ ...cadenceAddress(session.id), expectedRevision: current.revision }],
              sets: [
                { ...cadenceAddress(session.id), value: JSON.stringify(cadence) },
                {
                  ...reflectionAddress(session.id),
                  value: JSON.stringify({
                    ...input,
                    critique: input.critique.slice(0, MAX_SUMMARY_LENGTH),
                    resetPending: true,
                    completedAt: Date.now(),
                  }),
                },
              ],
              removes: [],
            })
            .pipe(
              Effect.as(true),
              Effect.catchTag("Storage.RevisionConflict", () => Effect.succeed(false)),
            )
          if (saved) return true
        }
      }),
      remove,
      resetPending: Effect.fn("Reflection.resetPending")(function* (sessionID) {
        const stored = yield* storage.get(reflectionAddress(sessionID))
        if (!stored) return false
        const decoded = Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Struct({ resetPending: Schema.Boolean })),
        )(stored.value)
        return Option.isSome(decoded) && decoded.value.resetPending
      }),
      resetComplete: Effect.fn("Reflection.resetComplete")(function* (sessionID) {
        const stored = yield* storage.get(reflectionAddress(sessionID))
        if (!stored) return
        const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(stored.value)
        if (Option.isNone(decoded) || typeof decoded.value !== "object" || decoded.value === null) return
        yield* storage.set({
          ...reflectionAddress(sessionID),
          value: JSON.stringify({ ...decoded.value, resetPending: false, resetCompletedAt: Date.now() }),
        })
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Storage.node, Database.node, EventV2.node] })
