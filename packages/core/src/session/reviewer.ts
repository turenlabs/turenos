export * as SessionReviewer from "./reviewer"

import { MAX_GUIDANCE, ProposalInput } from "@turenlabs/schema/session-harness"
import { AgentV2 } from "../agent"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionCreation } from "./creation"
import { SessionV1 } from "../v1/session"
import { Cause, Context, DateTime, Duration, Effect, Exit, Layer, Option, RcMap, Schema, Semaphore } from "effect"
import { createHash } from "node:crypto"
import { SessionHarness } from "./harness"
import { SessionMessage } from "./message"
import { SessionV2 } from "../session"
import { SessionSchema } from "./schema"
import { SessionEvent } from "./event"
import { Config } from "../config"
import { LocationServiceMap } from "../location-service-map"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import path from "node:path"

const REVIEWER_AGENT = AgentV2.ID.make("harness-reviewer")
const REVIEWER_TITLE = "Automatic Harness reviewer"
const INITIAL_DELAY = Duration.seconds(15)
const REVIEW_INTERVAL = Duration.minutes(3)
const REVIEW_MAX_IDLE = Duration.hours(48)
const REVIEW_CONTEXT_MESSAGES = 24
const REVIEW_CONTEXT_CHARS = 32_000
// One review must not hold a permit indefinitely; a stuck provider turn would otherwise stall
// reviewing for every other session with nothing surfaced to the user. The reviewer agent gathers
// evidence with grep/glob/read, so a thorough review is many provider turns: five minutes abandoned
// most reviews while they were still working normally.
const REVIEW_TIMEOUT = Duration.minutes(15)
// Bounded parallelism rather than one global permit. Fully serial review meant a new session waited
// behind every other session's turn, which measured at ~40 minutes before its first review ran.
// Sized for a heavy user running 5-10 sessions at once, so no session queues behind another; the
// digest skip and failure backoff are what bound total spend, not this number.
const REVIEW_CONCURRENCY = 10
// A failed review is usually a provider-level condition (rate limit, quota) that the next attempt
// three minutes later will hit again, so back that session off instead of re-queueing it promptly.
const FAILURE_BACKOFF = Duration.minutes(20)
// Each review appends a self-contained prompt to the reviewer child, so its context grows without
// bound. The prompt needs no history at all, so retire the child and start a fresh one instead.
const REVIEWS_PER_REVIEWER = 8
// Synthetic roots: handoff continuations and automation runs are not sessions a user is working in.
const SYNTHETIC_PREFIXES = ["ses_handoff_", "ses_loop_"]
const MAX_AUTOMATIC_CHANGES = 4
const MAX_AUTOMATIC_CONTENT_CHARS = 100_000

export interface Interface {
  readonly refresh: () => Effect.Effect<void>
  readonly withConfigTransition: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly invalidate?: boolean },
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionReviewer") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const creation = yield* SessionCreation.Service
    const harness = yield* SessionHarness.Service
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const reviewPermit = yield* Semaphore.make(REVIEW_CONCURRENCY)
    const withReviewPermit = reviewPermit.withPermit
    const configTransition = Semaphore.makeUnsafe(1)
    const withConfigTransition = configTransition.withPermit
    const active = new Set<SessionSchema.ID>()
    const reviewerSessions = new Map<SessionSchema.ID, SessionSchema.ID>()
    const reviewerUses = new Map<SessionSchema.ID, number>()
    const lastReviewed = new Map<SessionSchema.ID, string>()
    const scope = yield* Effect.scope
    let enabledGeneration = 0
    const invalidateConfigTransition = Effect.sync(() => {
      enabledGeneration += 1
      lastReviewed.clear()
    })

    const readGlobalEnabled = Effect.fn("SessionReviewer.readGlobalEnabled")(function* () {
      const unreadable = Symbol()
      const entries = yield* Effect.forEach(["config.json", ...Config.NAMES], (name) =>
        fs.readFileString(path.join(global.config, name)).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
          Effect.catch(() => Effect.succeed(unreadable)),
          Effect.map((text) =>
            text === unreadable
              ? unreadable
              : text
                ? Config.decodeDocument(text, path.join(global.config, name))
                : undefined,
          ),
        ),
      )
      // A transient read failure must retain the old eligibility path rather than silently disabling
      // a feature the user explicitly enabled.
      if (entries.includes(unreadable)) return true
      return harnessSelfModificationGloballyEnabled(
        entries.filter((entry): entry is Config.Document => entry !== undefined),
      )
    })
    let globallyEnabled = yield* readGlobalEnabled()
    const reconcileGlobalEnabled = Effect.fn("SessionReviewer.reconcileGlobalEnabled")(function* () {
      const enabled = yield* readGlobalEnabled()
      if (enabled === globallyEnabled) return false
      globallyEnabled = enabled
      yield* invalidateConfigTransition
      const refs = yield* RcMap.keys(locations.rcMap)
      yield* Effect.forEach(refs, (ref) => locations.invalidate(ref), { discard: true })
      return true
    })

    const selfModificationEnabled = Effect.fn("SessionReviewer.selfModificationEnabled")(function* (
      session: SessionSchema.Info,
    ) {
      if (!globallyEnabled) return false
      const entries = Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.entries()
      }).pipe(Effect.provide(locations.get(session.location)))
      return harnessSelfModificationEnabled(yield* entries)
    })

    const findReviewer = Effect.fn("SessionReviewer.findReviewer")(function* (parent: SessionSchema.Info) {
      const cached = reviewerSessions.get(parent.id)
      if (cached) {
        const existing = yield* sessions
          .get(cached)
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
        // Retire the child once it has accumulated enough prompts. Every review is self-contained,
        // so a fresh child costs nothing and keeps per-review input from growing to the context window.
        if (existing && existing.agent === REVIEWER_AGENT && (reviewerUses.get(cached) ?? 0) < REVIEWS_PER_REVIEWER)
          return existing
        reviewerSessions.delete(parent.id)
        reviewerUses.delete(cached)
      }

      // Deliberately not searching for an existing reviewer child by title: after a restart that
      // would adopt an arbitrarily large transcript, and the lookup scanned every session row.
      const created = yield* creation.create({
        parentID: parent.id,
        title: REVIEWER_TITLE,
        agent: REVIEWER_AGENT,
        model: parent.model,
        location: parent.location,
      })
      const reviewer = yield* sessions.get(created.id)
      reviewerSessions.set(parent.id, reviewer.id)
      return reviewer
    })

    const reviewOnce = Effect.fn("SessionReviewer.review")(function* (parent: SessionSchema.Info) {
      const state = yield* harness.get(parent.id)
      const context = yield* sessions.context(parent.id)
      const prompt = reviewerPrompt(parent, state, context)
      // The prompt is the entire input to a review, so an unchanged prompt can only produce the
      // answer already given. Without this an idle session is re-reviewed every interval forever.
      const digest = createHash("sha256").update(prompt).digest("hex")
      const generation = enabledGeneration
      if (lastReviewed.get(parent.id) === `${generation}:${digest}`) return
      // Recorded before the model call, not after it. Recording on success only meant a review that
      // timed out or failed re-ran byte-identical input every cycle forever. A session that is
      // actually being worked on changes its prompt, so it is still reviewed on the next pass.
      lastReviewed.set(parent.id, `${generation}:${digest}`)

      const reviewer = yield* findReviewer(parent)
      // Every exit below records why it ended. A background loop that returns silently is
      // indistinguishable from a broken one, which is exactly how the Harness tab looked empty.
      const record = (outcome: SessionHarness.ReviewerRunOutcome, detail?: string) =>
        harness.recordRun({
          sessionID: parent.id,
          reviewerSessionID: reviewer.id,
          outcome,
          ...(detail ? { detail } : {}),
        })
      const messageID = SessionMessage.ID.make(`msg_harness_review_${Date.now()}_${parent.id.slice(-12)}`)

      yield* sessions.prompt({
        id: messageID,
        sessionID: reviewer.id,
        prompt: { text: prompt },
        resume: false,
      })
      yield* sessions.resumePending(reviewer.id)

      const output = yield* reviewerOutput(sessions, reviewer.id)
      reviewerUses.set(reviewer.id, (reviewerUses.get(reviewer.id) ?? 0) + 1)
      if (output.kind === "declined") return yield* record("no_output", "Reviewer found nothing worth proposing")
      if (output.kind === "unreadable") return yield* record("unparseable", output.detail)
      const candidate = output.proposal
      if (generation !== enabledGeneration) return
      if (!(yield* selfModificationEnabled(parent))) return
      // A tools-only proposal is legitimate: disabling a tool that turned out to be useless needs no
      // file change. Requiring a change discarded exactly those, including cleanup of broken tools.
      if (
        candidate.changes.length === 0 &&
        (candidate.tools?.length ?? 0) === 0 &&
        (candidate.guidance?.length ?? 0) === 0
      )
        return yield* record("no_output", candidate.summary)

      yield* withConfigTransition(
        Effect.gen(function* () {
          if (generation !== enabledGeneration) return
          if (!(yield* selfModificationEnabled(parent))) return
          const latest = yield* harness.get(parent.id)
          if (!latest.snapshot) return yield* record("failed", "Session has no active harness snapshot")
          const snapshot = latest.snapshot
          if (latest.proposals.some((proposal) => proposalFingerprint(proposal) === proposalFingerprint(candidate)))
            return yield* record("duplicate", candidate.summary)

          const baseVersion = snapshot.version
          const proposal = yield* harness.propose({
            sessionID: parent.id,
            id: proposalID(parent.id, baseVersion, candidate),
            baseVersion,
            summary: candidate.summary,
            changes: candidate.changes,
            ...(candidate.tools === undefined ? {} : { tools: candidate.tools }),
            ...(candidate.guidance === undefined ? {} : { guidance: candidate.guidance }),
          })

          if (generation !== enabledGeneration) return
          if (!(yield* selfModificationEnabled(parent))) return
          if (!safeToApply(candidate, snapshot))
            return yield* record("proposed", `Awaiting approval: ${candidate.summary}`)
          yield* harness.status({
            sessionID: parent.id,
            proposalID: proposal.id,
            status: "approved",
            validation: { status: "passed", errors: [], warnings: [] },
          })
          if (generation !== enabledGeneration) return
          if (!(yield* selfModificationEnabled(parent))) return
          yield* harness.apply({ sessionID: parent.id, proposalID: proposal.id })
          yield* record("applied", candidate.summary)
        }),
      )
    })
    const review = (sessionID: SessionSchema.ID) =>
      withReviewPermit(
        Effect.gen(function* () {
          const parent = yield* sessions
            .get(sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
          if (!parent || !isReviewable(parent) || !isRecentlyActive(parent)) return "stop" as const
          if (!(yield* selfModificationEnabled(parent))) return "stop" as const
          yield* reviewOnce(parent)
          return "continue" as const
        }).pipe(
          Effect.timeoutOrElse({
            duration: REVIEW_TIMEOUT,
            orElse: () =>
              Effect.logWarning("Automatic Harness review timed out", { sessionID }).pipe(
                // Timing out only abandons the wait. The reviewer child joins its own drain, so
                // without an explicit interrupt it runs the turn to completion and bills for an
                // answer nobody reads. Interruption is best-effort: an idle child is a no-op.
                Effect.andThen(
                  Effect.suspend(() => {
                    const reviewerID = reviewerSessions.get(sessionID)
                    return reviewerID === undefined ? Effect.void : sessions.interrupt(reviewerID).pipe(Effect.ignore)
                  }),
                ),
                Effect.andThen(
                  harness.recordRun({
                    sessionID,
                    reviewerSessionID: reviewerSessions.get(sessionID) ?? "",
                    outcome: "timeout",
                    detail: `Review exceeded ${Duration.toSeconds(REVIEW_TIMEOUT)}s and was interrupted`,
                  }),
                ),
                Effect.as("backoff" as const),
              ),
          }),
        ),
      ).pipe(
        // A failed review is transient (provider error, version conflict). Only ineligibility stops
        // the cadence, otherwise one bad turn would silently end reviewing for the session's life.
        Effect.catchCause((cause) =>
          Effect.logWarning("Automatic Harness review failed", { cause }).pipe(
            Effect.andThen(
              harness.recordRun({
                sessionID,
                reviewerSessionID: "",
                outcome: "failed",
                detail:
                  Cause.squash(cause) instanceof Error
                    ? (Cause.squash(cause) as Error).message
                    : String(Cause.squash(cause)),
              }),
            ),
            Effect.as("backoff" as const),
          ),
        ),
      )

    const start = Effect.fn("SessionReviewer.start")(function* (session: SessionSchema.Info, force = false) {
      if (!globallyEnabled || !isReviewable(session) || (!force && !isRecentlyActive(session))) return
      const release = Effect.sync(() => active.delete(session.id))
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claimed = yield* Effect.sync(() => {
            if (active.has(session.id)) return false
            active.add(session.id)
            return true
          })
          if (!claimed) return
          const enabled = yield* restore(selfModificationEnabled(session)).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? release : Effect.void)),
          )
          if (!enabled) {
            yield* release
            return
          }
          yield* Effect.gen(function* () {
            yield* Effect.sleep(INITIAL_DELAY)
            const loop = (): Effect.Effect<void> =>
              Effect.gen(function* () {
                const outcome = yield* review(session.id)
                if (outcome === "stop") return
                yield* Effect.sleep(outcome === "backoff" ? FAILURE_BACKOFF : REVIEW_INTERVAL)
                yield* loop()
              })
            yield* loop()
          }).pipe(Effect.ensuring(release), Effect.forkIn(scope, { startImmediately: true }))
        }),
      )
    })
    const unsubscribe = yield* events.listen((event) => {
      const sessionID =
        event.type === SessionV1.Event.Created.type
          ? (event.data as typeof SessionV1.Event.Created.data.Type).sessionID
          : event.type === SessionEvent.PromptAdmitted.type
            ? (event.data as typeof SessionEvent.PromptAdmitted.data.Type).sessionID
            : undefined
      if (sessionID === undefined) return Effect.void
      return sessions.get(SessionSchema.ID.make(sessionID)).pipe(
        Effect.flatMap((session) => start(session, true)),
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const scan = Effect.fn("SessionReviewer.scan")(function* () {
      if (!globallyEnabled) return
      const known = yield* sessions.list()
      // The reviewer map is process-local, so without adopting the children that already exist every
      // restart mints a fresh one per session and orphans the last. Reuse is bounded by the same
      // retirement counter as a live child, so an adopted transcript still gets retired.
      const adopted = new Map<SessionSchema.ID, SessionSchema.Info>()
      for (const session of known) {
        if (session.title !== REVIEWER_TITLE || session.parentID === undefined || session.agent !== REVIEWER_AGENT)
          continue
        // Newest wins: the older children are the ones a previous restart already grew and abandoned.
        const previous = adopted.get(session.parentID)
        if (previous && DateTime.toEpochMillis(previous.time.created) >= DateTime.toEpochMillis(session.time.created))
          continue
        adopted.set(session.parentID, session)
      }
      for (const [parentID, reviewer] of adopted) reviewerSessions.set(parentID, reviewer.id)
      // Explicit lambda: Effect.forEach passes the array index as the second argument, which would
      // land in `start`'s `force` parameter and force-start every session after the first.
      yield* Effect.forEach(known.filter(isReviewable), (session) => start(session), {
        concurrency: 4,
        discard: true,
      })
    })
    yield* scan()

    const refresh = Effect.fn("SessionReviewer.refresh")(function* () {
      yield* withConfigTransition(
        Effect.gen(function* () {
          yield* invalidateConfigTransition
          yield* reconcileGlobalEnabled()
          yield* scan()
        }),
      )
    })

    const transition = <A, E, R>(effect: Effect.Effect<A, E, R>, options?: { readonly invalidate?: boolean }) =>
      withConfigTransition(
        options?.invalidate
          ? Effect.gen(function* () {
              yield* invalidateConfigTransition
              return yield* effect.pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    const changed = yield* reconcileGlobalEnabled()
                    yield* invalidateConfigTransition
                    if (changed && globallyEnabled)
                      yield* scan().pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
                  }),
                ),
              )
            })
          : effect,
      )

    return Service.of({ refresh, withConfigTransition: transition })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    LocationServiceMap.node,
    SessionCreation.node,
    SessionV2.node,
    SessionHarness.node,
    FSUtil.node,
    Global.node,
  ],
})

export function harnessSelfModificationEnabled(entries: readonly Config.Entry[]) {
  const boundary = entries.findIndex((entry) => entry.type === "directory")
  const globalEntries = entries.slice(0, boundary < 0 ? 1 : boundary)
  const locationEntries = entries.slice(boundary < 0 ? 1 : boundary + 1)
  return (
    harnessSelfModificationGloballyEnabled(globalEntries) &&
    locationEntries
      .filter((entry): entry is Config.Document => entry.type === "document")
      .every((entry) => entry.info.experimental?.harness_self_modification !== false)
  )
}

export function harnessSelfModificationGloballyEnabled(entries: readonly Config.Entry[]) {
  return (
    entries
      .filter((entry): entry is Config.Document => entry.type === "document")
      .findLast((entry) => entry.info.experimental?.harness_self_modification !== undefined)?.info.experimental
      ?.harness_self_modification === true
  )
}

function isReviewable(session: SessionSchema.Info) {
  return (
    session.parentID === undefined &&
    session.time.archived === undefined &&
    session.title !== REVIEWER_TITLE &&
    !SYNTHETIC_PREFIXES.some((prefix) => session.id.startsWith(prefix))
  )
}

function isRecentlyActive(session: SessionSchema.Info) {
  return Date.now() - DateTime.toEpochMillis(session.time.updated) <= Duration.toMillis(REVIEW_MAX_IDLE)
}

function reviewerPrompt(
  parent: SessionSchema.Info,
  state: SessionHarness.State,
  context: ReadonlyArray<SessionMessage.Message>,
) {
  const snapshot = state.snapshot
  const harness = snapshot
    ? JSON.stringify({
        version: snapshot.version,
        changes: snapshot.changes.map((change) => ({
          operation: change.operation,
          path: change.path,
          summary: change.summary,
        })),
        tools: snapshot.tools,
        guidance: snapshot.guidance ?? [],
      })
    : "null"
  const transcript = context
    .slice(-REVIEW_CONTEXT_MESSAGES)
    .map(messageText)
    .filter(Boolean)
    .join("\n\n")
    .slice(-REVIEW_CONTEXT_CHARS)
  const requests = state.reviewerRequests
    .slice(-8)
    .map((request) => `- ${request.request}`)
    .join("\n")

  return [
    "You are the automatic Harness reviewer for a TurenOS session.",
    "Inspect the parent session transcript and active Harness snapshot below.",
    "Look for one small, concrete improvement that is useful on the next provider turn.",
    "Prefer a bounded read-only harness_ tool or a source-backed harness change.",
    "You may also propose `guidance`: standing instructions injected into the agent's system prompt every turn.",
    "Guidance is the right choice when the transcript shows the agent re-deriving something the session already settled, ignoring an existing harness tool, or repeating a mistake it already made. Name the trigger in `appliesTo` (a file path or topic) and give one imperative directive.",
    "Guidance steers the agent; it cannot force it. Keep each directive short, specific, and worth spending prompt budget on every single turn.",
    "When guidance is present, return the complete desired list: it replaces the current one.",
    `Return no more than ${MAX_GUIDANCE} guidance items. If the current list is full, remove resolved or redundant items before adding a new one.`,
    "Every tool name must start with `harness_` and use only letters, digits, underscores and hyphens.",
    `The built-in ${SessionHarness.REVIEW_REQUEST_TOOL_NAME} name is reserved; do not propose a custom tool with it.`,
    "Return the JSON as one strict JSON object: escape every quote, backslash and newline inside `content`. Do not wrap the source in its own code fence.",
    "Tool source is NOT a TypeScript module. It is the body of one confined CodeMode program, so it has no module system:",
    "- `import`, `export`, and `require` are parse errors. There is no way to load a file, module, or dependency.",
    "- There is no filesystem, network, process, or shell access, and no host tools. A tool that needs any of those is impossible; do not propose it.",
    "- `input` (the caller's arguments) and `context` (sessionID, agent, assistantMessageID, toolCallID) are already declared. Do not redeclare either name.",
    "- Write plain statements ending in `return <value>`. Classes, generators, timers, and eval are unavailable.",
    "A tool that only reimplements grep, glob, read, or running the test suite is not worth proposing; the agent already has those and they are faster.",
    "When tools are present, return the complete desired tool list, including any existing tools that should remain enabled.",
    "Do not modify files, use tools, or propose writable tools, deletes, patches, dependencies, network, credentials, or process execution.",
    'If there is no worthwhile improvement, return exactly {"decision":"none"}.',
    'If there is an improvement, return only JSON matching this shape. `changes`, `tools` and `guidance` are all optional, so a guidance-only proposal is valid: {"decision":"proposal","baseVersion":1,"summary":"...","changes":[{"path":"tools/harness_example.ts","operation":"add","content":"return input"}],"tools":[{"name":"harness_example","description":"...","source":"tools/harness_example.ts","readOnly":true,"enabled":true}],"guidance":[{"appliesTo":"src/mem.rs","directive":"Call harness_mem_baseline and diff against it before editing."}]}',
    `Parent session: ${parent.id}`,
    `Active Harness snapshot: ${harness}`,
    `Requests from the parent agent:\n${requests || "(none)"}`,
    `Parent transcript:\n${transcript || "(no projected messages yet)"}`,
  ].join("\n\n")
}

function messageText(message: SessionMessage.Message) {
  if (message.type === "user" || message.type === "system" || message.type === "synthetic")
    return `${message.type}: ${message.text}`
  if (message.type === "shell") return `shell: ${message.command}\n${message.output}`
  if (message.type !== "assistant") return ""
  const text = message.content
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") return [part.text]
      if (part.type !== "tool") return []
      return part.state.status === "completed" ? [`tool ${part.name}: ${JSON.stringify(part.state.structured)}`] : []
    })
    .join("\n")
  return text ? `assistant: ${text}` : ""
}

function reviewerOutput(sessions: SessionV2.Interface, reviewerID: SessionSchema.ID) {
  return sessions.messages({ sessionID: reviewerID, order: "desc", limit: 20 }).pipe(
    Effect.map((messages) => {
      const output = messages.find(
        (message): message is SessionMessage.Assistant =>
          message.type === "assistant" && message.error === undefined && message.time.completed !== undefined,
      )
      const text = output?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? ""
      return parseReviewerReply(text)
    }),
  )
}

export function parseReviewerReply(text: string) {
  // The dedicated Harness agent normally returns one object, but keeping candidate extraction
  // tolerant makes old reviewer children and provider-added formatting harmless during migration.
  const values = proposalCandidates(text).flatMap((candidate) => {
    const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(candidate)
    return Option.isSome(decoded) ? [withPrefixedToolNames(decoded.value)] : []
  })
  const proposal = values.flatMap((value) => {
    const decoded = Schema.decodeUnknownOption(ProposalInput)(value)
    // Normalize the optional change list once, so the rest of the reviewer can treat a
    // guidance-only or tools-only proposal exactly like any other.
    return Option.isSome(decoded) && "summary" in decoded.value
      ? [{ ...decoded.value, changes: decoded.value.changes ?? [] }]
      : []
  })[0]
  if (proposal) return { kind: "proposal", proposal } as const
  // The prompt asks for exactly {"decision":"none"} when nothing is worth proposing. That is a
  // completed review with no work, so reporting it as a malformed reply told the user the
  // reviewer was broken every time it correctly found nothing.
  if (values.some(isDecline)) return { kind: "declined" } as const
  // Say which half failed. "Could not be read" covered both a reply with no JSON at all and one
  // whose JSON the schema rejected, which are different problems with different fixes.
  const detail =
    text.length === 0
      ? "The reviewer produced no reply"
      : values.length === 0
        ? "The reviewer reply contained no valid JSON"
        : "The reviewer JSON did not match the proposal shape"
  return { kind: "unreadable", detail } as const
}

function isDecline(value: unknown) {
  return typeof value === "object" && value !== null && (value as { decision?: unknown }).decision === "none"
}

/**
 * Adds the required `harness_` prefix to proposed tool names that omit it. The schema rejects the
 * whole proposal on one bad name, so a sound review was being discarded over a naming convention.
 * Only the name is touched; source paths are declared explicitly and still resolve.
 */
function withPrefixedToolNames(value: unknown) {
  if (typeof value !== "object" || value === null) return value
  const tools = (value as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return value
  return {
    ...value,
    tools: tools.map((tool) => {
      if (typeof tool !== "object" || tool === null) return tool
      const name = (tool as { name?: unknown }).name
      if (typeof name !== "string" || name.startsWith("harness_")) return tool
      return { ...tool, name: `harness_${name}` }
    }),
  }
}

function proposalCandidates(text: string) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]?.trim() ?? "")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const span = start >= 0 && end > start ? [text.slice(start, end + 1)] : []
  return [...fenced, ...span].filter((candidate) => candidate.includes("{"))
}

function proposalID(sessionID: SessionSchema.ID, baseVersion: SessionHarness.Version, candidate: ProposalInput) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sessionID,
        baseVersion,
        summary: candidate.summary,
        changes: candidate.changes,
        tools: candidate.tools,
        guidance: candidate.guidance,
      }),
    )
    .digest("hex")
    .slice(0, 24)
  return SessionHarness.ProposalID.make(`hpr_auto_${digest}`)
}

/**
 * Must cover every field a proposal carries. Omitting one makes two proposals that differ only in
 * that field collide, and the second is discarded as a duplicate that can never land.
 */
function proposalFingerprint(proposal: {
  readonly summary: string
  readonly changes: unknown
  readonly tools?: unknown
  readonly guidance?: unknown
}) {
  return JSON.stringify({
    summary: proposal.summary,
    changes: proposal.changes,
    tools: proposal.tools,
    guidance: proposal.guidance,
  })
}

function safeToApply(candidate: ProposalInput, snapshot: SessionHarness.Snapshot) {
  // A tool list replaces the snapshot's list wholesale, so auto-applying one that omits an existing
  // tool silently uninstalls it. Removing a tool is a human decision, and the reviewer is told to
  // resend the full list, which makes accidental omission the likely failure.
  if (candidate.tools !== undefined) {
    const proposed = new Map(candidate.tools.map((tool) => [tool.name, tool]))
    // Omitting an enabled tool uninstalls it; listing it as disabled turns it off. Both remove a
    // capability the session already has, so both wait for a human rather than auto-applying.
    if (snapshot.tools.some((tool) => tool.enabled && proposed.get(tool.name)?.enabled !== true)) return false
  }
  // Guidance replaces wholesale too, so a list that drops a standing instruction erases it. Adding
  // or revising guidance is routine; removing one the session accumulated is a human decision.
  if (candidate.guidance !== undefined) {
    const proposed = new Set(candidate.guidance.map((item) => item.directive))
    if ((snapshot.guidance ?? []).some((item) => !proposed.has(item.directive))) return false
  }
  const changes = candidate.changes ?? []
  if (changes.length > MAX_AUTOMATIC_CHANGES) return false
  if (changes.reduce((total, change) => total + (change.content?.length ?? 0), 0) > MAX_AUTOMATIC_CONTENT_CHARS)
    return false
  if (
    changes.some(
      (change) =>
        (change.operation !== "add" && change.operation !== "modify") ||
        change.content === undefined ||
        (!change.path.startsWith("src/") && !change.path.startsWith("tools/")),
    )
  )
    return false
  return (candidate.tools ?? []).every((tool) => tool.readOnly && tool.enabled && tool.name.startsWith("harness_"))
}
