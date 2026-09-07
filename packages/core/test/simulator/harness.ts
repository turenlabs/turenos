/**
 * Scenario simulator for TurenOS's agent-turn pipeline.
 *
 * Runs the *real* session stack — `SessionV2` -> `SessionExecutionLocal` -> coordinator ->
 * `SessionRunnerLLM` -> tools/questions/subagents -> projector/store — against a fully
 * controllable in-process LLM provider. No network, no API spend, no TestClock: scenarios run on
 * the live clock (`it.live`) because the behaviors under study (slow first byte, stalls,
 * interrupts racing streams) are wall-clock phenomena. Keep configured delays small (5-300ms).
 *
 * Surface:
 *   - `simulate(name, script)`  — one scenario == one bun test. The script receives a
 *     `ScenarioContext` with `provider` / `user` / `phase` / `invariants` / `services`.
 *     Every scenario is wrapped in a 20s real-clock hang guard whose failure message names the
 *     last completed script step.
 *   - `matrix({ provider, user }, run)` — calls `run` once per provider x user combo so a suite
 *     can generate one `simulate` per valid pairing.
 *   - Behavior builders: `reply`, `replyWithTool`, `overloadedThenReply`, `contextOverflow`,
 *     `transportError`.
 *
 * ## Provider ordering contract
 *
 * `provider.enqueue` appends behaviors to a single queue shared by EVERY provider request in the
 * scenario — parent turns, continuation turns, retry attempts, and child (subagent) sessions all
 * draw from it. Each incoming `stream()` call consumes the FIRST queued behavior whose `match`
 * predicate accepts the request (default: matches anything), i.e. plain FIFO when no `match` is
 * given. A request with no matching behavior is a scripting error and dies loudly (it never
 * hangs silently).
 *
 * For subagent scenarios this matters: `spawn_agent` returns as soon as the child prompt is
 * admitted, so the parent's follow-up request and the child's first request race. Give every
 * behavior of a multi-session scenario a `match` on the request's user text (see
 * `requestUserTexts`) so parent and child turns each deterministically pick their own scripted
 * responses regardless of scheduling order.
 *
 * ## Settlement expectation mapping
 *
 * Durable session status is written by the projector off runner events. A user interrupt of a
 * live turn settles the transcript with `Step.Failed` carrying an interruption message ("Provider
 * turn interrupted", "... before it started"); the literal `"interrupted"` status is only written
 * by `V2Session.recover` after a process restart. `invariants.settled` therefore maps:
 *   - `"idle"`        -> status `idle`
 *   - `"failed"`      -> status `failed` with a non-interruption message
 *   - `"interrupted"` -> status `interrupted`, or status `failed` whose message names an
 *                        interruption (the in-process interrupt signature).
 */
import { test } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  type LLMClientShape,
  type LLMRequest,
} from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { ConfigCompaction } from "@turenlabs/core/config/compaction"
import { Database } from "@turenlabs/core/database/database"
import { makeLocationNode } from "@turenlabs/core/effect/app-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Project, ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { QuestionV2 } from "@turenlabs/core/question"
import { ReferenceGuidance } from "@turenlabs/core/reference/guidance"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { SessionGoal } from "@turenlabs/core/session/goal"
import type { SessionInput } from "@turenlabs/core/session/input"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionProjector } from "@turenlabs/core/session/projector"
import * as SessionRunnerLLM from "@turenlabs/core/session/runner/llm"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import type { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { Snapshot } from "@turenlabs/core/snapshot"
import { SystemContext } from "@turenlabs/core/system-context"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { ApplicationTools } from "@turenlabs/core/tool/application-tools"
import { GoalTool } from "@turenlabs/core/tool/goal"
import { QuestionTool } from "@turenlabs/core/tool/question"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { Tool } from "@turenlabs/core/tool/tool"
import { and, eq, isNull } from "drizzle-orm"
import { DateTime, Deferred, Duration, Effect, Layer, LayerMap, Schema, Scope, Stream } from "effect"
import { testEffect } from "../lib/effect"
import type { UsageEmulator } from "./cache-emulator"

// ---------------------------------------------------------------------------------------------
// ScenarioProvider — the controllable in-process LLM client
// ---------------------------------------------------------------------------------------------

export interface ScenarioBehavior {
  /** Names the behavior in the request log and in error messages. */
  readonly label?: string
  /**
   * Events to stream. May be an Effect so a behavior can be computed at request time (e.g. a
   * `wait_agents` call whose task IDs only exist after the spawn actually ran).
   */
  readonly events: ReadonlyArray<LLMEvent> | Effect.Effect<ReadonlyArray<LLMEvent>>
  /** Picks which requests this behavior may serve. Default: any request. */
  readonly match?: (request: LLMRequest) => boolean
  /** Delay before the first event is emitted. */
  readonly firstByteDelayMs?: number
  /** Delay between subsequent events. */
  readonly interEventDelayMs?: number
  /** Emit `count` events, then fail the stream with a typed `LLMError`. */
  readonly failAfter?: { readonly count: number; readonly error: LLMError }
  /** Emit `count` events, then die with a defect mid-stream. */
  readonly dieAfter?: { readonly count: number; readonly defect?: unknown }
  /** Emit `count` events, then never emit again — only an interrupt ends the stream. */
  readonly stallAfter?: { readonly count: number }
}

export interface RequestRecord {
  readonly request: LLMRequest
  readonly label: string | undefined
}

interface RequestInstrument {
  /** Resolved when the request's first event is emitted (after `firstByteDelayMs`). */
  readonly firstByte: Deferred.Deferred<void>
  /** Resolved when the scripted provider stream reaches a successful natural end. */
  readonly ended: Deferred.Deferred<void>
  /** Resolved when a `stallAfter` behavior has emitted its allotment and parked forever. */
  readonly stalled: Deferred.Deferred<void>
}

const behaviorQueue: ScenarioBehavior[] = []
const requestLog: RequestRecord[] = []
const requestInstruments = new Map<number, RequestInstrument>()
/** Ordered log of completed script steps, used by every failure message in the harness. */
const steps: string[] = []

const step = (label: string) => Effect.sync(() => void steps.push(label))
const stepTrail = () => (steps.length === 0 ? "(no steps recorded)" : steps.join(" -> "))

const instrumentFor = (requestIndex: number): RequestInstrument => {
  let instrument = requestInstruments.get(requestIndex)
  if (!instrument) {
    instrument = {
      firstByte: Deferred.makeUnsafe<void>(),
      ended: Deferred.makeUnsafe<void>(),
      stalled: Deferred.makeUnsafe<void>(),
    }
    requestInstruments.set(requestIndex, instrument)
  }
  return instrument
}

/** All user-message text fragments of a request, for `match` predicates. */
export const requestUserTexts = (request: LLMRequest): string[] =>
  request.messages.flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

const behaviorStream = (behavior: ScenarioBehavior, requestIndex: number): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const configured = behavior.events
      const all: ReadonlyArray<LLMEvent> = Effect.isEffect(configured) ? yield* configured : configured
      const cut = behavior.stallAfter?.count ?? behavior.failAfter?.count ?? behavior.dieAfter?.count
      const emitted = cut === undefined ? all : all.slice(0, cut)
      const instrument = instrumentFor(requestIndex)
      const base = Stream.fromIterable(emitted.map((event, index) => [event, index] as const)).pipe(
        Stream.mapEffect(([event, index]) =>
          Effect.gen(function* () {
            const delay = index === 0 ? (behavior.firstByteDelayMs ?? 0) : (behavior.interEventDelayMs ?? 0)
            if (delay > 0) yield* Effect.sleep(Duration.millis(delay))
            if (index === 0) yield* Deferred.succeed(instrument.firstByte, undefined)
            return event
          }),
        ),
      )
      const tail: Stream.Stream<LLMEvent, LLMError> = behavior.stallAfter
        ? Stream.fromEffect(Deferred.succeed(instrument.stalled, undefined)).pipe(Stream.flatMap(() => Stream.never))
        : behavior.failAfter
          ? Stream.fail(behavior.failAfter.error)
          : behavior.dieAfter
            ? Stream.fromEffect(
                Effect.die(behavior.dieAfter.defect ?? new Error("ScenarioProvider: simulated mid-stream defect")),
              )
            : Stream.empty
      return Stream.concat(base, tail).pipe(Stream.onEnd(Deferred.succeed(instrument.ended, undefined)))
    }),
  )

const withEmulatedUsage = (
  request: LLMRequest,
  label: string | undefined,
  emulator: UsageEmulator,
  stream: Stream.Stream<LLMEvent, LLMError>,
): Stream.Stream<LLMEvent, LLMError> => {
  let outputChars = 0
  return stream.pipe(
    Stream.mapEffect((event) =>
      Effect.gen(function* () {
        if (LLMEvent.is.textDelta(event)) outputChars += event.text.length
        else if (LLMEvent.is.reasoningDelta(event)) outputChars += event.text.length
        else if (LLMEvent.is.toolCall(event)) outputChars += JSON.stringify(event.input ?? null).length
        // The publisher settles usage from `step-finish`, never from `finish`.
        if (!LLMEvent.is.stepFinish(event)) return event
        const usage = yield* emulator.observe(request, label, outputChars)
        return usage === undefined
          ? event
          : LLMEvent.stepFinish({
              index: event.index,
              reason: event.reason,
              usage,
              ...(event.providerMetadata === undefined ? {} : { providerMetadata: event.providerMetadata }),
            })
      }),
    ),
  )
}

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("ScenarioProvider: prepare is never called by a provider turn"),
    stream: ((request: LLMRequest) =>
      Stream.unwrap(
        Effect.sync(() => {
          const index = behaviorQueue.findIndex((candidate) => (candidate.match ?? (() => true))(request))
          if (index < 0)
            return Stream.die(
              new Error(
                `ScenarioProvider: no behavior matches request #${requestLog.length} ` +
                  `(user texts: ${JSON.stringify(requestUserTexts(request))}); ` +
                  `${behaviorQueue.length} behavior(s) still queued; steps: ${stepTrail()}`,
              ),
            )
          const behavior = behaviorQueue.splice(index, 1)[0]!
          const requestIndex = requestLog.length
          requestLog.push({ request, label: behavior.label })
          const produced = behaviorStream(behavior, requestIndex)
          const emulator = usageEmulatorOverride
          return emulator === undefined ? produced : withEmulatedUsage(request, behavior.label, emulator, produced)
        }),
      )) as unknown as LLMClientShape["stream"],
    // Turns always stream; `generate` is only reached by background work (e.g. titling), which
    // the harness sidesteps by inserting sessions with a non-placeholder title.
    generate: (() => Effect.die("ScenarioProvider: generate is never called in simulator scenarios")) as never,
  }),
)

// ---------------------------------------------------------------------------------------------
// Behavior builders
// ---------------------------------------------------------------------------------------------

let contentCounter = 0

const replyEvents = (text: string, chunks: number, id: string): LLMEvent[] => {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, chunks)))
  const deltas: string[] = []
  for (let at = 0; at < text.length; at += size) deltas.push(text.slice(at, at + size))
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id }),
    ...deltas.map((delta) => LLMEvent.textDelta({ id, text: delta })),
    LLMEvent.textEnd({ id }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

export type BehaviorOverrides = Partial<Omit<ScenarioBehavior, "events">> & { readonly chunks?: number }

/** A complete assistant text turn. `chunks` controls how many text deltas the reply streams as. */
export const reply = (text: string, overrides: BehaviorOverrides = {}): ScenarioBehavior => {
  const { chunks, ...rest } = overrides
  return { label: rest.label ?? "reply", events: replyEvents(text, chunks ?? 3, `text-${++contentCounter}`), ...rest }
}

/** A turn that calls one tool and stops for its result (`finish: tool-calls`). */
export const replyWithTool = (name: string, input: unknown, overrides: BehaviorOverrides = {}): ScenarioBehavior => {
  const { chunks: _chunks, ...rest } = overrides
  return {
    label: rest.label ?? `tool:${name}`,
    events: toolCallEvents(name, input),
    ...rest,
  }
}

/** Raw events for a one-tool-call turn; useful inside lazy (`Effect`) behavior events. */
export const toolCallEvents = (name: string, input: unknown): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: `call-${++contentCounter}`, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

/**
 * A retryable provider-error frame (Anthropic-style `overloaded_error` on a 200) followed by a
 * successful reply if text is provided, or just the error if text is undefined. The runner holds
 * the retryable frame back from the transcript and retries the attempt after its backoff delay —
 * the first backoff is 2 seconds on the live clock, so budget scenario deadlines accordingly.
 */
export const overloadedThenReply = (text?: string): ScenarioBehavior[] => {
  const behaviors: ScenarioBehavior[] = [
    {
      label: "overloaded",
      events: [LLMEvent.providerError({ message: "Overloaded", retryable: true })],
    },
  ]
  if (text !== undefined) behaviors.push(reply(text, { label: "reply-after-overload" }))
  return behaviors
}

/** A context-overflow provider-error frame; the runner routes this to overflow compaction. */
export const contextOverflow = (): ScenarioBehavior => ({
  label: "context-overflow",
  events: [LLMEvent.providerError({ message: "Prompt is too long", classification: "context-overflow" })],
})

/** A typed transport failure for `failAfter`. Not session-retried: the executor layer owns transport replays. */
export const transportError = (message = "Simulated transport failure"): LLMError =>
  new LLMError({ module: "simulator", method: "stream", reason: new TransportReason({ message }) })

// ---------------------------------------------------------------------------------------------
// Scenario toolkit tools
// ---------------------------------------------------------------------------------------------

const toolRunSignals = new Map<string, Deferred.Deferred<void>>()
const toolRunSignal = (name: string): Deferred.Deferred<void> => {
  let signal = toolRunSignals.get(name)
  if (!signal) {
    signal = Deferred.makeUnsafe<void>()
    toolRunSignals.set(name, signal)
  }
  return signal
}
const signalToolRunning = (name: string) => Effect.suspend(() => Deferred.succeed(toolRunSignal(name), undefined))

const simTools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      sim_slow: Tool.make({
        description: "Sleep for the given number of milliseconds, then return.",
        input: Schema.Struct({ ms: Schema.Number }),
        output: Schema.Struct({ slept: Schema.Number }),
        toModelOutput: ({ output }) => [{ type: "text", text: `slept ${output.slept}ms` }],
        execute: ({ ms }) =>
          signalToolRunning("sim_slow").pipe(
            Effect.andThen(Effect.sleep(Duration.millis(ms))),
            Effect.as({ slept: ms }),
          ),
      }),
      sim_hang: Tool.make({
        description: "Never settles; only an interrupt ends it.",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => signalToolRunning("sim_hang").pipe(Effect.andThen(Effect.never)),
      }),
      sim_huge: Tool.make({
        description: "Return the requested number of bytes of text.",
        // `padding` models a write/patch body: bytes the model itself placed in the call input,
        // which history replays verbatim on every later turn. Output pruning never touches
        // them — exactly the blind spot the input-prune bench scenarios measure.
        input: Schema.Struct({ bytes: Schema.Number, padding: Schema.String.pipe(Schema.optional) }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ bytes }) => signalToolRunning("sim_huge").pipe(Effect.as({ text: "x".repeat(bytes) })),
      }),
      sim_big: Tool.make({
        description: "Return the requested number of bytes with small structured metadata.",
        // The realistic tool shape (read/grep-like): metadata stays small while the
        // text content carries the bulk. The durable 512KB cap estimates JSON at 8x,
        // so this passes ~56KB through where sim_huge's mirrored structured output
        // would be cut to ~5KB — the shape that actually reaches prune pressure.
        input: Schema.Struct({ bytes: Schema.Number }),
        output: Schema.Struct({ size: Schema.Number }),
        toModelOutput: ({ input }) => [{ type: "text", text: "x".repeat(input.bytes) }],
        execute: ({ bytes }) => signalToolRunning("sim_big").pipe(Effect.as({ size: bytes })),
      }),
      sim_fail: Tool.make({
        description: "Fail with a typed tool failure.",
        input: Schema.Struct({ message: Schema.optional(Schema.String) }),
        output: Schema.Struct({}),
        execute: ({ message }) =>
          signalToolRunning("sim_fail").pipe(
            Effect.andThen(Effect.fail(new Tool.Failure({ message: message ?? "Simulated tool failure" }))),
          ),
      }),
    }),
  ),
)
const simToolsNode = makeLocationNode({ name: "test/simulator-tools", layer: simTools, deps: [ToolRegistry.node] })

// ---------------------------------------------------------------------------------------------
// Graph assembly — mirrors test/session-runner.test.ts, with the real local execution stack so
// subagent tasks settle exactly as they do in production.
// ---------------------------------------------------------------------------------------------

// A real directory: SubagentTool canonicalizes the active workspace root with `fs.realPath`
// before spawning, so a fictional "/project" would fail every spawn with "Active workspace root
// is unavailable". Nothing in the scenarios writes here (Snapshot is noop, sim tools are pure).
const directory = AbsolutePath.make(process.cwd())
const models = SessionRunnerModel.layerWith((session) =>
  Effect.sync(() => {
    const model = Model.make({
      id: "sim-model",
      provider: "sim",
      route: OpenAIChat.route.with({
        limits: {
          context: modelContextLimitOverride.context ?? 200_000,
          output: modelContextLimitOverride.output ?? 4_000,
        },
      }),
    })
    return {
      model,
      ref: ModelV2.Ref.make({
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
      }),
      // A stub model has no catalog entry and therefore no price list.
      cost: [],
    }
  }),
)
// Pin every directory to the global project: subagent spawn validates that the child Session's
// project/directory placement matches its parent row exactly, and the real resolver would derive
// a per-worktree project for `directory` that differs from the seeded global row.
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (input: AbsolutePath) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const permission = Layer.mock(PermissionV2.Service, {
  // Tools that consult permissions (question, spawn_agent, ...) are always allowed here; policy
  // enforcement has its own suites.
  assert: () => Effect.void,
})
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
/**
 * Per-scenario compaction overrides for A/B benchmarks (context-bench).
 *
 * Set synchronously in the bun-test callback (see `simulate`), never from inside a scenario
 * script: the runner materializes `config.entries()` once at layer build (`runner/llm.ts`),
 * which happens when the test's Effect starts — before any script line runs. A script-side
 * setter looks like it works while every test silently captures the previous test's override;
 * that exact off-by-one shipped the first bench run of the dedup experiment.
 */
let compactionOverride: Partial<ConstructorParameters<typeof ConfigCompaction.Info>[0]> = {}
/** Per-scenario model context limit overrides to trigger natural compaction in tests. */
let modelContextLimitOverride: { context?: number; output?: number } = {}
/**
 * Per-scenario usage emulator (cache-bench). When set, every scripted provider
 * stream is wrapped to accumulate output chars and attach emulated `Usage` to
 * the terminal `step-finish`, exercising the real usage pipeline end to end.
 * Unset for every other suite: their streams flow untouched.
 */
let usageEmulatorOverride: UsageEmulator | undefined
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.sync(() => [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
              ...compactionOverride,
            }),
          }),
        }),
      ]),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [Location.node, Location.boundNode({ directory })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [ProjectV2.node, projects],
  [Config.node, config],
])
// Every Location resolves to the runner rig above: the local execution drain, question dismissal
// and compaction all reach the same memoized service instances the main graph uses.
const executionLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => runnerLayer as unknown as Layer.Layer<LocationServices>),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionGoal.node,
      SessionCreation.node,
      SessionTaskV2.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      simToolsNode,
      GoalTool.node,
      QuestionTool.node,
      SubagentTool.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [Location.node, Location.boundNode({ directory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, SessionExecutionLocal.node],
      [LocationServiceMap.node, executionLocations],
      [ProjectV2.node, projects],
      [Config.node, config],
    ],
  ),
)

// ---------------------------------------------------------------------------------------------
// Scenario context
// ---------------------------------------------------------------------------------------------

export type SettleExpectation = "idle" | "failed" | "interrupted"

/**
 * How a `session.resume` can fail. Derived from the service so the deferred handed to a scenario
 * carries the drain's real error channel instead of pretending resume is infallible.
 */
export type ResumeError = Effect.Error<ReturnType<SessionV2.Interface["resume"]>>

export interface SettleOptions {
  readonly expect: SettleExpectation
  /**
   * How long quiescence may take, in milliseconds. Defaults to `SETTLE_DEADLINE_MS`.
   *
   * Only raise it for a scenario whose *product* behaviour mandates real waiting — a retry ladder
   * without a provider deadline sleeps `2s, 4s, 8s, ...` on the live clock (session/runner/retry.ts,
   * `INITIAL_DELAY_MS` x `BACKOFF_FACTOR`, jittered up to x1.25). Everything else must settle inside
   * the default: a raised deadline hides a hang.
   */
  readonly deadlineMs?: number
  /**
   * Minimum provider requests (across all sessions) before quiescence counts as settlement.
   * Guards the race where the drain has not started yet and the coordinator briefly looks idle.
   * Defaults to 1.
   */
  readonly minRequests?: number
  /**
   * Interruption deliberately preserves durable steer/queue input for a later resume; scenarios
   * that interrupt with input still docked opt in here instead of failing the orphan check.
   */
  readonly allowPendingInput?: boolean
  /** Scenarios that deliberately leave subagent tasks running opt out of the terminal-task check. */
  readonly allowActiveTasks?: boolean
}

export interface ScenarioContext {
  readonly sessionID: SessionSchema.ID
  readonly provider: {
    readonly enqueue: (...behaviors: ReadonlyArray<ScenarioBehavior | ReadonlyArray<ScenarioBehavior>>) => void
    readonly requests: () => ReadonlyArray<RequestRecord>
    readonly queued: () => number
    /**
     * Shorthand for repeated-failure scenarios: enqueue a sequence of retryable errors
     * followed by a terminal behavior (success or final failure).
     *
     * @param errors Array of typed LLMErrors, each becomes a behavior that fails immediately.
     * @param thenReply The terminal behavior (reply, overloadedThenReply, etc.)
     *
     * Usage:
     *   ctx.provider.retrySequence(
     *     [rateLimited(1), rateLimited(2), rateLimited(3)],
     *     reply("Recovered on fourth attempt.")
     *   )
     *
     * Equivalent to:
     *   ctx.provider.enqueue(
     *     { label: "429-1", events: [], failAfter: { count: 0, error: ... } },
     *     { label: "429-2", events: [], failAfter: { count: 0, error: ... } },
     *     { label: "429-3", events: [], failAfter: { count: 0, error: ... } },
     *     reply("Recovered on fourth attempt.")
     *   )
     */
    readonly retrySequence: (errors: ReadonlyArray<LLMError>, thenReply: ScenarioBehavior) => void
  }
  readonly user: {
    readonly prompt: (
      text: string,
      options?: {
        /**
         * Client-minted durable message identity. Real callers mint the ID themselves so a retry
         * of an admission whose response was lost reconciles instead of duplicating the message;
         * scenarios that exercise that reconciliation pass the same ID twice (idempotency.test.ts).
         */
        readonly id?: SessionMessage.ID
        readonly delivery?: "steer" | "queue"
        readonly resume?: boolean
        /** Attachments exactly as the composer sends them (screenshot pastes, file mentions). */
        readonly files?: ReadonlyArray<{ readonly uri: string; readonly mime: string; readonly name?: string }>
      },
      // Returns the durable admission record so identity scenarios can assert on the sequence
      // numbers a retry must reproduce. Every other scenario simply ignores it.
    ) => Effect.Effect<SessionInput.Admitted>
    /** Records a completed shell surface message durably, as the terminal surface does. */
    readonly shell: (command: string, output: string) => Effect.Effect<void>
    readonly interrupt: () => Effect.Effect<void>
    readonly resume: () => Effect.Effect<void>
    /**
     * Resume with interceptable caller cancellation.
     * Unlike fire-and-forget resume(), this returns a Deferred<void> that the test can await.
     * The test's fiber waiting on the deferred can be interrupted WITHOUT interrupting the
     * process-owned drain, allowing scenarios to test caller disconnection vs. session termination.
     *
     * Usage pattern:
     *   const join = yield* ctx.user.resumeWithCancel()
     *   yield* ctx.phase.afterFirstByte()
     *   yield* Fiber.interrupt(caller)  // Cancels the caller's wait
     *   yield* ctx.invariants.settled()  // Drain continues despite caller cancellation
     */
    readonly resumeWithCancel: () => Effect.Effect<Deferred.Deferred<void, ResumeError>>
    /**
     * Send a wake signal to the coordinator without claiming the drain.
     * Increments pendingWake without calling resume(), used to test the coalescing behavior
     * of multiple wake signals racing with settle.
     *
     * Usage: Test that N concurrent wakes coalesce into one successor drain request.
     */
    readonly wakeNoResume: () => Effect.Effect<void>
    readonly answerQuestion: (answers?: ReadonlyArray<ReadonlyArray<string>>) => Effect.Effect<void>
    readonly rejectQuestion: () => Effect.Effect<void>
  }
  readonly phase: {
    readonly afterFirstByte: (requestIndex?: number) => Effect.Effect<void>
    readonly afterProviderEnd: (requestIndex?: number) => Effect.Effect<void>
    /**
     * Resolves once the turn's assistant message exists durably (`Step.Started` projected).
     * The publisher starts the assistant lazily on the first *content* frame, so "first byte"
     * (usually `step-start`) precedes this — an interrupt in the pre-content window settles as an
     * unstarted interruption instead of a streamed one, so scenarios that want the streamed shape
     * wait for this phase, not just `afterFirstByte` (see the pre-content interrupt regression
     * scenario in the turn-matrix suite).
     */
    readonly whenAssistantStreaming: () => Effect.Effect<void>
    readonly whileStalled: (requestIndex?: number) => Effect.Effect<void>
    readonly whenQuestionPending: () => Effect.Effect<QuestionV2.Request>
    readonly whenToolRunning: (name: string) => Effect.Effect<void>
    /**
     * Execute N concurrent callers in parallel, each independently invoking the given effect.
     * Returns the parallel results, allowing scenarios to test wake storms, concurrent admissions,
     * and coordinator serialization without manually managing Fiber.fork/join.
     *
     * Each caller receives:
     *   - index: caller number (0..count-1)
     *   - sessionID: context's sessionID or overridden ID
     *
     * Usage:
     *   yield* ctx.phase.concurrentCallers(5, ({ index }) =>
     *     ctx.user.prompt(`Caller ${index}`)
     *   )
     *
     * Determinism: callers run with `concurrency: "unbounded"`, so order is nondeterministic;
     * scenarios should assert set membership and per-text multiplicity, not order.
     */
    readonly concurrentCallers: <R, E, A>(
      count: number,
      each: (params: { readonly index: number; readonly sessionID?: SessionSchema.ID }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<ReadonlyArray<A>, E, R>
  }
  readonly invariants: {
    readonly settled: (sessionID: SessionSchema.ID, options: SettleOptions) => Effect.Effect<void>
  }
  /** Shared live service handles for scenario-specific assertions and lazy behaviors. */
  readonly services: {
    readonly session: SessionV2.Interface
    readonly goals: SessionGoal.Interface
    readonly questions: QuestionV2.Interface
    readonly tasks: SessionTaskV2.Interface
    readonly store: SessionStore.Interface
    readonly db: Database.Interface["db"]
  }
  readonly step: (label: string) => Effect.Effect<void>
}

const invariant = (name: string, detail: string): never => {
  throw new Error(`[invariant:${name}] ${detail}; steps: ${stepTrail()}`)
}

const INTERRUPTION_MESSAGE = /interrupt/i

const statusMatches = (expect: SettleExpectation, row: { status: string; status_message: string | null }): boolean => {
  switch (expect) {
    case "idle":
      return row.status === "idle"
    case "failed":
      return row.status === "failed" && !INTERRUPTION_MESSAGE.test(row.status_message ?? "")
    case "interrupted":
      return (
        row.status === "interrupted" || (row.status === "failed" && INTERRUPTION_MESSAGE.test(row.status_message ?? ""))
      )
  }
}

const isTerminalToolState = (state: SessionMessage.ToolState) =>
  state.status === "completed" || state.status === "error"

const SETTLE_DEADLINE_MS = 5_000
const SETTLE_POLL_MS = 25
const HANG_GUARD_MS = 20_000

let scenarioCounter = 0
let scenarioShellCounter = 0

const makeContext = Effect.fnUntraced(function* (name: string) {
  // The layer (and its :memory: database) is rebuilt per test; the module-scope provider and
  // instrumentation state is what carries over and must be reset here.
  behaviorQueue.length = 0
  requestLog.length = 0
  requestInstruments.clear()
  toolRunSignals.clear()
  steps.length = 0
  contentCounter = 0

  const index = ++scenarioCounter
  const sessionID = SessionV2.ID.make(`ses_sim_${String(index).padStart(4, "0")}`)
  // Callers that "disconnect" are forked HERE, into the scenario's own scope, never with
  // `Effect.forkChild`. `forkChild` attaches to whatever fiber happens to be running the step, and
  // a caller fired from inside `Effect.all`/`Effect.forEach`/`concurrentCallers` runs in a fiber
  // that finishes the instant the step returns — which interrupts the resume before it ever claims
  // a drain, so the scenario observes zero provider requests and blames the coordinator. Scoped
  // here, a resume outlives its caller exactly as a process-owned drain does in production, and the
  // test scope still interrupts anything left over at the end of the scenario.
  const scope = yield* Scope.Scope
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const db = database.db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory,
      // Deliberately not a placeholder title so the runner never forks title generation (which
      // would hit the dead `generate` on the scenario provider).
      title: `simulator: ${name}`,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  const allowAll: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
  yield* agents.transform((editor) => {
    editor.update(AgentV2.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.permissions = [...allowAll]
    })
    editor.update(AgentV2.ID.make("explore"), (agent) => {
      agent.mode = "subagent"
      agent.hidden = false
      agent.permissions = [...allowAll]
    })
  })

  const session = yield* SessionV2.Service
  const goals = yield* SessionGoal.Service
  const questions = yield* QuestionV2.Service
  const tasks = yield* SessionTaskV2.Service
  const store = yield* SessionStore.Service

  const pollUntil = <A>(label: string, get: Effect.Effect<A | undefined>, timeoutMs = SETTLE_DEADLINE_MS) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      while (true) {
        const value = yield* get
        if (value !== undefined) return value
        if (Date.now() - startedAt > timeoutMs)
          return yield* Effect.die(
            new Error(`[poll:${label}] not satisfied within ${timeoutMs}ms; steps: ${stepTrail()}`),
          )
        yield* Effect.sleep(Duration.millis(SETTLE_POLL_MS))
      }
    })

  const pendingQuestionFor = (target: SessionSchema.ID) =>
    questions.list().pipe(Effect.map((pending) => pending.find((request) => request.sessionID === target)))

  const sessionRow = (target: SessionSchema.ID) =>
    db
      .select({
        status: SessionTable.status,
        status_message: SessionTable.status_message,
        status_owner: SessionTable.status_owner,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, target))
      .get()
      .pipe(Effect.orDie)

  const settled = (target: SessionSchema.ID, options: SettleOptions) =>
    Effect.gen(function* () {
      yield* step(`invariants.settled(${target}, ${options.expect})`)
      const minRequests = options.minRequests ?? 1
      const deadlineMs = options.deadlineMs ?? SETTLE_DEADLINE_MS
      // Phase 1: bounded poll for quiescence — the run coordinator holds no entry for the session
      // and the durable status has reached the expected terminal shape.
      const startedAt = Date.now()
      let snapshot = ""
      while (true) {
        const active = yield* session.active
        const row = yield* sessionRow(target)
        snapshot =
          `requests=${requestLog.length}/${minRequests} active=${JSON.stringify([...active])} ` +
          `status=${row?.status} message=${JSON.stringify(row?.status_message ?? null)}`
        if (
          requestLog.length >= minRequests &&
          !active.has(target) &&
          row !== undefined &&
          statusMatches(options.expect, row)
        )
          break
        if (Date.now() - startedAt > deadlineMs)
          invariant(
            "settled",
            `session ${target} did not settle as "${options.expect}" within ${deadlineMs}ms (${snapshot})`,
          )
        yield* Effect.sleep(Duration.millis(SETTLE_POLL_MS))
      }
      const row = (yield* sessionRow(target))!
      if (row.status_owner !== null)
        invariant("status-owner", `terminal session ${target} still names a status owner ${row.status_owner}`)
      // Phase 2: transcript settlement — every assistant message completed, every tool part terminal.
      const messages = yield* store.context(target).pipe(Effect.orDie)
      for (const message of messages) {
        if (message.type !== "assistant") continue
        if (message.time.completed === undefined)
          invariant("assistant-unsettled", `assistant ${message.id} in ${target} has no completed timestamp`)
        for (const part of message.content) {
          if (part.type !== "tool") continue
          if (!isTerminalToolState(part.state))
            invariant(
              "tool-part-nonterminal",
              `tool part ${part.id} (${target}, message ${message.id}) is still "${part.state.status}"`,
            )
        }
      }
      // Phase 3: no orphaned admitted input (unless the scenario relies on durable preservation).
      if (!options.allowPendingInput) {
        const pending = yield* db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, target),
              isNull(SessionInputTable.promoted_seq),
              isNull(SessionInputTable.time_cancelled),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        if (pending.length > 0)
          invariant(
            "orphaned-input",
            `session ${target} left ${pending.length} admitted input row(s) neither promoted nor cancelled: ` +
              pending.map((row) => row.id).join(", "),
          )
      }
      // Phase 4: no pending questions.
      const question = yield* pendingQuestionFor(target)
      if (question !== undefined)
        invariant("pending-question", `session ${target} still has pending question request ${question.id}`)
      // Phase 5: subagent tasks terminal.
      if (!options.allowActiveTasks) {
        const children = yield* tasks.list({ parentSessionID: target })
        const nonTerminal = children.filter((task) => task.status === "starting" || task.status === "running")
        if (nonTerminal.length > 0)
          invariant(
            "active-task",
            `session ${target} left non-terminal subagent task(s): ` +
              nonTerminal.map((task) => `${task.id}=${task.status}`).join(", "),
          )
      }
    })

  const context: ScenarioContext = {
    sessionID,
    provider: {
      enqueue: (...behaviors) => {
        for (const entry of behaviors)
          if (Array.isArray(entry)) behaviorQueue.push(...(entry as ReadonlyArray<ScenarioBehavior>))
          else behaviorQueue.push(entry as ScenarioBehavior)
      },
      requests: () => [...requestLog],
      queued: () => behaviorQueue.length,
      retrySequence: (errors, thenReply) => {
        const errorBehaviors: ScenarioBehavior[] = errors.map((error, index) => ({
          label: `error-${index}`,
          events: [],
          failAfter: { count: 0, error },
        }))
        // Use the enqueue closure directly
        for (const entry of errorBehaviors) behaviorQueue.push(entry)
        behaviorQueue.push(thenReply)
      },
    },
    user: {
      prompt: (text, options) =>
        step(
          `user.prompt(${JSON.stringify(text)}${options?.id ? ` id=${options.id}` : ""}${
            options && (options.delivery || options.resume || options.files)
              ? ` opts=${JSON.stringify({ delivery: options.delivery, resume: options.resume, files: !!options.files })}`
              : ""
          })`,
        ).pipe(
          Effect.andThen(
            session.prompt({
              ...(options?.id ? { id: options.id } : {}),
              sessionID,
              prompt: Prompt.make({ text, ...(options?.files ? { files: options.files } : {}) }),
              ...(options?.delivery === undefined ? {} : { delivery: options.delivery }),
              ...(options?.resume === undefined ? {} : { resume: options.resume }),
            }),
          ),
          Effect.orDie,
        ),
      shell: (command, output) =>
        step(`user.shell(${JSON.stringify(command.slice(0, 40))})`).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const callID = `shell_${++scenarioShellCounter}`
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                callID,
                command,
              })
              yield* events.publish(SessionEvent.Shell.Ended, {
                sessionID,
                timestamp: yield* DateTime.now,
                callID,
                output,
                status: "completed",
              })
            }),
          ),
          Effect.orDie,
          Effect.asVoid,
        ),
      interrupt: () => step("user.interrupt").pipe(Effect.andThen(session.interrupt(sessionID)), Effect.orDie),
      // Fire-and-forget on purpose: joining a resume of a stalled or failing run would wedge or
      // kill the script fiber; settlement is always observed through `invariants.settled`. The
      // observer fiber belongs to the scenario scope (see `scope` above), not to whichever step
      // fired it, and the drain itself lives in the coordinator's own fiber set and outlives both.
      resume: () =>
        step("user.resume").pipe(
          Effect.andThen(session.resume(sessionID).pipe(Effect.exit, Effect.forkIn(scope, { startImmediately: true }))),
          Effect.asVoid,
        ),
      resumeWithCancel: () =>
        step("user.resumeWithCancel").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const deferred = yield* Deferred.make<void, ResumeError>()
              // Fire-and-forget the resume into the scenario scope, signaling completion to the
              // deferred. The deferred await can be interrupted independently from the drain.
              yield* session.resume(sessionID).pipe(
                Effect.exit,
                Effect.tap((exit) => Deferred.complete(deferred, exit)),
                Effect.forkIn(scope, { startImmediately: true }),
              )
              return deferred
            }),
          ),
        ),
      wakeNoResume: () =>
        step("user.wakeNoResume").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // Access the session input to record a durable wake without claiming the drain.
              // This increments pendingWake without calling resume(). The scheduler will promote it
              // in the next drain.
              yield* session.wake(sessionID).pipe(Effect.orDie)
            }),
          ),
        ),
      answerQuestion: (answers) =>
        step("user.answerQuestion").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const request = yield* pollUntil("question-pending", pendingQuestionFor(sessionID))
              const resolved = answers ?? request.questions.map((info) => [info.options[0]?.label ?? "ok"])
              yield* questions.reply({ requestID: request.id, answers: resolved }).pipe(Effect.orDie)
            }),
          ),
        ),
      rejectQuestion: () =>
        step("user.rejectQuestion").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const request = yield* pollUntil("question-pending", pendingQuestionFor(sessionID))
              yield* questions.reject(request.id).pipe(Effect.orDie)
            }),
          ),
        ),
    },
    phase: {
      afterFirstByte: (requestIndex = 0) =>
        step(`phase.afterFirstByte(#${requestIndex})`).pipe(
          Effect.andThen(Deferred.await(instrumentFor(requestIndex).firstByte)),
        ),
      afterProviderEnd: (requestIndex = 0) =>
        step(`phase.afterProviderEnd(#${requestIndex})`).pipe(
          Effect.andThen(Deferred.await(instrumentFor(requestIndex).ended)),
        ),
      whenAssistantStreaming: () =>
        step("phase.whenAssistantStreaming").pipe(
          Effect.andThen(
            pollUntil(
              "assistant-streaming",
              db
                .select({ id: SessionMessageTable.id })
                .from(SessionMessageTable)
                .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
                .get()
                .pipe(Effect.orDie),
            ),
          ),
          Effect.asVoid,
        ),
      whileStalled: (requestIndex = 0) =>
        step(`phase.whileStalled(#${requestIndex})`).pipe(
          Effect.andThen(Deferred.await(instrumentFor(requestIndex).stalled)),
        ),
      whenQuestionPending: () =>
        step("phase.whenQuestionPending").pipe(
          Effect.andThen(pollUntil("question-pending", pendingQuestionFor(sessionID))),
        ),
      whenToolRunning: (name) =>
        step(`phase.whenToolRunning(${name})`).pipe(Effect.andThen(Deferred.await(toolRunSignal(name)))),
      concurrentCallers: (count, each) =>
        step(`phase.concurrentCallers(count=${count})`).pipe(
          Effect.andThen(
            Effect.all(
              Array.from({ length: count }, (_, index) => each({ index, sessionID }).pipe(Effect.exit)),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.map((exits) =>
                exits.map((exit) => {
                  if (exit._tag === "Success") return exit.value
                  throw new Error(`concurrentCallers[${count}] failed: ${exit.cause}`)
                }),
              ),
            ),
          ),
        ),
    },
    invariants: { settled },
    services: { session, goals, questions, tasks, store, db },
    step,
  }
  return context
})

// ---------------------------------------------------------------------------------------------
// simulate + matrix
// ---------------------------------------------------------------------------------------------

type ScenarioScript = (context: ScenarioContext) => Effect.Effect<unknown, unknown, any>

const runScenario = (name: string, script: ScenarioScript) =>
  Effect.gen(function* () {
    const context = yield* makeContext(name)
    yield* (script(context) as Effect.Effect<unknown>).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(HANG_GUARD_MS),
        orElse: () =>
          Effect.die(
            new Error(
              `[simulate:${name}] hang guard tripped after ${HANG_GUARD_MS}ms; ` +
                `last completed step: ${steps.at(-1) ?? "(none)"}; steps: ${stepTrail()}; ` +
                `provider requests served: ${requestLog.length}, behaviors still queued: ${behaviorQueue.length}`,
            ),
          ),
      }),
    )
  })

export interface SimulateOptions {
  /** Compaction config folded over the harness defaults for this scenario only. */
  readonly compaction?: typeof compactionOverride
  /** Model context limits to trigger natural compaction in this scenario. Default: 200k context, 4k output. */
  readonly modelContextLimit?: { context?: number; output?: number }
  /** Usage emulator attached to every scripted provider stream (cache-bench only). */
  readonly usageEmulator?: UsageEmulator
}

/** One scenario == one bun test on the live clock, with a 20s hang guard around the script. */
export const simulate = (name: string, script: ScenarioScript, options?: SimulateOptions) =>
  it.live(
    name,
    () => {
      // Synchronous, pre-Effect: the layer (and the runner's one-shot config capture) builds
      // when the returned Effect runs, so this is the last moment the override can land.
      compactionOverride = options?.compaction ?? {}
      modelContextLimitOverride = options?.modelContextLimit ?? {}
      usageEmulatorOverride = options?.usageEmulator
      return runScenario(name, script) as Effect.Effect<unknown, unknown, any>
    },
    30_000,
  )
simulate.only = (name: string, script: ScenarioScript, options?: SimulateOptions) =>
  it.live.only(
    name,
    () => {
      compactionOverride = options?.compaction ?? {}
      modelContextLimitOverride = options?.modelContextLimit ?? {}
      usageEmulatorOverride = options?.usageEmulator
      return runScenario(name, script) as Effect.Effect<unknown, unknown, any>
    },
    30_000,
  )
simulate.skip = (name: string, script: ScenarioScript, _options?: SimulateOptions) =>
  it.live.skip(name, () => runScenario(name, script) as Effect.Effect<unknown, unknown, any>, 30_000)
/** Records a scenario that documents a FINDING without executing it. */
simulate.todo = (name: string, _script?: ScenarioScript) => test.todo(name, () => {})

export interface MatrixCombo<P, U> {
  readonly providerName: string
  readonly userName: string
  readonly provider: P
  readonly user: U
}

/** Calls `run` once per provider x user combination; `run` decides whether to `simulate` it. */
export const matrix = <P, U>(
  dims: { readonly provider: Readonly<Record<string, P>>; readonly user: Readonly<Record<string, U>> },
  run: (combo: MatrixCombo<P, U>) => void,
): void => {
  for (const [providerName, provider] of Object.entries(dims.provider))
    for (const [userName, user] of Object.entries(dims.user)) run({ providerName, userName, provider, user })
}
