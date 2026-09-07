import { describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  LLMResponse,
  Model,
  QuotaExceededReason,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import * as OpenAIResponses from "@turenlabs/llm/protocols/openai-responses"
import { Database } from "@turenlabs/core/database/database"
import { makeLocationNode } from "@turenlabs/core/effect/app-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { PermissionV2 } from "@turenlabs/core/permission"
import { EventTable } from "@turenlabs/core/event/sql"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { QuestionV2 } from "@turenlabs/core/question"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionCompaction } from "@turenlabs/core/session/compaction"
import { SessionContextRequest } from "@turenlabs/core/session/context-request"
import { Snapshot } from "@turenlabs/core/snapshot"
import { ContextSnapshotDecodeError } from "@turenlabs/core/session/error"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionGoal } from "@turenlabs/core/session/goal"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { ProviderPrompt } from "@turenlabs/core/session/provider-prompt"
import { SessionTodo } from "@turenlabs/core/session/todo"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionControl } from "@turenlabs/core/session/execution-control"
import { SessionRunCoordinator } from "@turenlabs/core/session/run-coordinator"
import { SessionRunner } from "@turenlabs/core/session/runner"
import * as SessionRunnerLLM from "@turenlabs/core/session/runner/llm"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionRunnerRetry } from "@turenlabs/core/session/runner/retry"
import { SessionStatus } from "@turenlabs/core/session/status"
import { Reflection } from "@turenlabs/core/reflection"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ReflectionTool } from "@turenlabs/core/tool/reflection"
import { GoalTool } from "@turenlabs/core/tool/goal"
import { ApplicationTools } from "@turenlabs/core/tool/application-tools"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { ConfigCompaction } from "@turenlabs/core/config/compaction"
import { Tool } from "@turenlabs/core/tool/tool"
import {
  SessionContextEpochTable,
  SessionContextRequestTable,
  SessionGoalTable,
  SessionGoalTurnTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  TodoTable,
} from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SystemContext } from "@turenlabs/core/system-context"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { ReferenceGuidance } from "@turenlabs/core/reference/guidance"
import { ModelV2 } from "@turenlabs/core/model"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { ProviderV2 } from "@turenlabs/core/provider"
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  LayerMap,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { and, asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { afterExecutorRetries, anthropicRateLimited, executorFailure } from "./lib/provider-failure"
import { AgentPlugin } from "@turenlabs/core/plugin/agent"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { location as locationFixture } from "./fixture/location"
import { agentHost, host } from "./plugin/host"

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
/** A distinguishable duration on either the test clock or the live approval test. */
const SLOW_TOOL_DELAY = Duration.millis(120)
let approvalGate: Deferred.Deferred<void> | undefined
let approvalPrompted: Deferred.Deferred<void> | undefined
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    // Only background work uses `generate`; a turn always streams. Left dead unless a test arms
    // `generated`, so any unexpected one-shot call still fails loudly.
    generate: ((request: LLMRequest) => {
      generateRequests.push(request)
      return generated ? Effect.succeed(generated) : Effect.die("unused")
    }) as unknown as LLMClientShape["generate"],
  }),
)
const generateRequests: LLMRequest[] = []
let generated: LLMResponse | undefined
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const streamRecoveryModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIResponses.route })
const compactStreamRecoveryModel = Model.make({
  id: "stream-recovery-compact",
  provider: "fake",
  route: OpenAIResponses.route.with({ limits: { context: 4_000, output: 50 } }),
})
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const testDirectory = AbsolutePath.make(process.cwd())
// Every turn leads with the prompt selected for the resolved model. None of these fake ids match a
// provider rule, so they all resolve to the shipped fallback; the assertions below spell it out
// rather than slicing it off, so losing the provider prompt is a failure and not a silent pass.
const defaultPrompt = ProviderPrompt.fallback
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const compactionSummary = (objective: string) => `## Objective
- ${objective}

## Important Details
- (none)

## Work State
### Completed
- (none)

### Active
- Continue

### Blocked
- (none)

## Next Move
1. Continue
2. (none)

## Relevant Files
- (none)

## Durable Memories
- (none)`
/**
 * The fact-extraction turn that follows every successful summary.
 *
 * A compaction makes two provider calls: the summary, then a short extraction whose bullets are
 * appended to the checkpoint's append-only ledger. Any `responses` queue that drives a compaction
 * has to supply this one too, or the extraction silently consumes the turn queued after it. Only a
 * summary that validates is extracted from, so a queue whose summary fails must NOT include one.
 */
const compactionLedger = (fact: string) =>
  fragmentFixture("text", `ledger-${fact.replace(/[^a-z0-9]+/gi, "-")}`, [`- ${fact}`]).completeEvents
const authorizations: Tool.Context[] = []
const executions: string[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: ({ action }) => (action.startsWith("harness_") ? Effect.void : Effect.die("unused")),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
      // A real Effect sleep makes both duration and active concurrency observable.
      slow: Tool.make({
        description: "Sleep for a measurable interval",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) =>
          Effect.gen(function* () {
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (executions.length === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            yield* Effect.sleep(SLOW_TOOL_DELAY)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      // Models a call that has to wait on the user: it blocks until the harness answers, exactly
      // as a permission prompt blocks until the human replies.
      approval: Tool.make({
        description: "Wait for out-of-band approval",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) =>
          Effect.gen(function* () {
            executions.push(text)
            if (approvalPrompted) yield* Deferred.succeed(approvalPrompted, undefined)
            if (approvalGate) yield* Deferred.await(approvalGate)
            return { text }
          }),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
let modelResolveHook = Effect.void
let currentModel = model
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(
    Effect.as(session.model?.id === "replacement" ? replacementModel : currentModel),
    Effect.map((model) => ({
      model,
      ref: ModelV2.Ref.make({
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
      }),
      // These models are stubs with no catalog entry, so they have no price
      // list -- the same state a subscription-billed transport is in.
      cost: [],
    })),
  ),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const runnerLayer = AppNodeBuilder.build(
  LayerNode.group([SessionRunnerLLM.node, SessionTodo.node, SessionHarness.node, ReflectionTool.node]),
  [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory: testDirectory })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
  ],
)
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force, control) => sessionRunner.run({ sessionID, force, control }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      claimResume: coordinator.claim,
      claimPending: coordinator.claimPending,
      resume: coordinator.run,
      wake: coordinator.wake,
      wakeForced: coordinator.wakeForced,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
// `V2Session.compact` reaches the Location-scoped runner the same way `shell` and `command` do.
// This rig injects the runner directly through `SessionExecution`, so without an equivalent map
// the real one would try to build Location services for the test directory that does not
// exist on disk.
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
      SessionTodo.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      GoalTool.node,
      ReflectionTool.node,
      Reflection.node,
      SessionRunnerModel.node,
      SessionHarness.node,
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
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: testDirectory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [LocationServiceMap.node, executionLocations],
      [Config.node, config],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: testDirectory,
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  requests.length = 0
  response = []
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  approvalGate = undefined
  approvalPrompted = undefined
  yield* db.delete(SessionGoalTurnTable).where(eq(SessionGoalTurnTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(SessionGoalTable).where(eq(SessionGoalTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(TodoTable).where(eq(TodoTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: testDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  generateRequests.length = 0
  generated = undefined
  yield* insertSession(sessionID)
})

/**
 * Titling is forked into the runner layer's scope, so the run it belongs to returns before it
 * finishes -- which is the whole point. Yield until the name lands rather than sleeping, so the
 * test asserts on completion rather than on a duration.
 */
const settledTitle = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = yield* db
        .select({ title: SessionTable.title })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
      if (row && !SessionCreation.isPlaceholderTitle(row.title)) return row.title
      yield* Effect.yieldNow
    }
    return undefined
  })

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ kind: "Stream", message: "Provider unavailable" }),
  })

const providerSocketClosed = () =>
  new LLMError({
    module: "ProviderShared",
    method: "stream",
    reason: new TransportReason({
      kind: "Stream",
      message:
        "Failed to read openai/openai-responses stream: Decode error (200 POST https://chatgpt.com/backend-api/codex/responses): terminated: other side closed: UND_ERR_SOCKET",
    }),
  })

const providerRejected = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new InvalidRequestReason({ message: "Provider rejected the request" }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")
const requestSystemTexts = (request: LLMRequest) => request.system.map((part) => part.text)
const runtimeTexts = (request: LLMRequest, previous?: LLMRequest) =>
  request.messages.slice(previous?.messages.length ?? 0).flatMap((message) => {
    const forge = message.metadata?.forge
    return message.role === "system" &&
      typeof forge === "object" &&
      forge !== null &&
      "internalContext" in forge &&
      forge.internalContext === "runtime"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : []
  })
const expectStablePrefix = (previous: LLMRequest, request: LLMRequest) => {
  expect(request.system).toEqual(previous.system)
  expect(request.messages.slice(0, previous.messages.length)).toEqual([...previous.messages])
}

// Adopt event-backed history without ever rendering a request. Unique old results exceed both
// pruning budgets; duplicate results and a large write input exercise the other reduction paths.
const adoptPrunableHistory = Effect.gen(function* () {
  const session = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const database = yield* Database.Service
  const outputs = Array.from(
    { length: 10 },
    (_, index) => `${index < 2 ? "duplicate" : `old-${index}`} ${"x".repeat(60_000)}`,
  )
  const input = { filePath: "old.txt", content: "original write body ".repeat(300) }
  for (const [index, output] of outputs.entries()) {
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Historical request ${index}` }), resume: false })
    yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
    const assistantMessageID = SessionMessage.ID.create()
    const timestamp = yield* DateTime.now
    const callID = `adopted-${index}`
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      timestamp,
      agent: "build",
      model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      timestamp,
      callID,
      name: index === 0 ? "write" : "echo",
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      timestamp,
      callID,
      text: JSON.stringify(index === 0 ? input : { text: `old-${index}` }),
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      timestamp,
      callID,
      tool: index === 0 ? "write" : "echo",
      input: index === 0 ? input : { text: `old-${index}` },
      provider: { executed: false },
    })
    yield* events.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID,
      timestamp,
      callID,
      structured: {},
      content: [{ type: "text", text: output }],
      provider: { executed: false },
    })
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      timestamp,
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  }
  return { outputs, input }
})

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerRejected()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider rejected the request" },
        content: [fixture.expectedContent],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner
      .run({ sessionID, force: true, control: SessionExecutionControl.noop })
      .pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

const statusRow = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({
        status: SessionTable.status,
        status_owner: SessionTable.status_owner,
        status_attempt: SessionTable.status_attempt,
        status_message: SessionTable.status_message,
        status_next: SessionTable.status_next,
        status_action: SessionTable.status_action,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(Effect.orDie)
    return row!
  })

describe("SessionRunnerLLM", () => {
  it.effect("pins file attachment bytes across tool turns and separate resumes", () =>
    Effect.gen(function* () {
      yield* setup
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(tmpdir(), "forge-rendered-frame-"))),
        (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
      )
      const file = path.join(directory, "context.txt")
      yield* Effect.promise(() => Bun.write(file, "Original attachment bytes: café"))
      const session = yield* SessionV2.Service
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "attachment-echo", name: "echo", input: { text: "checked" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "attachment-final", ["Checked attachment"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Check the attachment",
          files: [{ uri: pathToFileURL(file).href, mime: "text/plain", name: "context.txt" }],
        }),
        resume: false,
      })
      toolExecutionsReady = 1
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionGate = yield* Deferred.make<void>()
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      expect(userTexts(requests[0]!).join("\n")).toContain("Original attachment bytes: café")
      yield* Effect.promise(() => Bun.write(file, "Changed during tool execution"))
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(running)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined
      expect(requests).toHaveLength(2)
      expectStablePrefix(requests[0]!, requests[1]!)
      expect(userTexts(requests[1]!).join("\n")).not.toContain("Changed during tool execution")

      yield* Effect.promise(() => Bun.write(file, "Changed between separate resumes"))
      response = fragmentFixture("text", "attachment-resumed", ["Still checked"]).completeEvents
      responses = undefined
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Check once more" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expectStablePrefix(requests[1]!, requests[2]!)
      expect(userTexts(requests[2]!).join("\n")).toContain("Original attachment bytes: café")
      expect(userTexts(requests[2]!).join("\n")).not.toContain("Changed between separate resumes")
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("advertises and executes an applied Harness tool", () =>
    Effect.gen(function* () {
      yield* setup
      const harness = yield* SessionHarness.Service
      const session = yield* SessionV2.Service
      const proposal = yield* harness.propose({
        sessionID,
        baseVersion: 1,
        summary: "Add a task-local uppercase helper",
        changes: [
          {
            path: RelativePath.make("tools/harness_upper.ts"),
            operation: "add",
            content: "return input.value.toUpperCase()",
          },
        ],
        tools: [
          {
            name: "harness_upper",
            description: "Uppercase one supplied string.",
            source: RelativePath.make("tools/harness_upper.ts"),
            readOnly: true,
            enabled: true,
          },
        ],
      })
      yield* harness.status({ sessionID, proposalID: proposal.id, status: "approved" })
      yield* harness.apply({ sessionID, proposalID: proposal.id })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use the task-local helper" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-harness-upper", name: "harness_upper", input: { value: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-harness-final" }),
          LLMEvent.textDelta({ id: "text-harness-final", text: "Used the helper" }),
          LLMEvent.textEnd({ id: "text-harness-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("harness_upper")
      const firstRequest = requests[0]
      expect(firstRequest).toBeDefined()
      expect(runtimeTexts(firstRequest!).join("\n")).toContain("Harness adoption protocol")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use the task-local helper" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-harness-upper",
              state: { status: "completed", structured: { value: "HELLO" } },
            },
          ],
        },
        { type: "assistant", content: [{ type: "text", text: "Used the helper" }] },
      ])
    }),
  )

  it.effect("reloads an applied Harness tool before the next provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const harness = yield* SessionHarness.Service
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Wait for a Harness update" }), resume: false })
      responses = [
        fragmentFixture("text", "harness-before", ["Before the update"]).completeEvents,
        fragmentFixture("text", "harness-after", ["After the update"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const proposal = yield* harness.propose({
        sessionID,
        baseVersion: 1,
        summary: "Add a task-local uppercase helper",
        changes: [
          {
            path: RelativePath.make("tools/harness_upper.ts"),
            operation: "add",
            content: "return input.value.toUpperCase()",
          },
        ],
        tools: [
          {
            name: "harness_upper",
            description: "Uppercase one supplied string.",
            source: RelativePath.make("tools/harness_upper.ts"),
            readOnly: true,
            enabled: true,
          },
        ],
      })
      yield* harness.status({ sessionID, proposalID: proposal.id, status: "approved" })
      yield* harness.apply({ sessionID, proposalID: proposal.id })
      yield* execution.wakeForced?.(sessionID) ?? Effect.void
      yield* Deferred.succeed(streamGate, undefined)
      streamGate = undefined
      streamStarted = undefined
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("harness_upper")
      expect(requests[1]?.tools.map((tool) => tool.name)).toContain("harness_upper")
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run automatically" }) })
      yield* session.resumePending(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
      // Every other session in this file is inserted already named, and `generate` dies unless a
      // test arms it -- so the suite as a whole is the assertion that a named session is never
      // re-titled.
      expect(generateRequests).toHaveLength(0)
    }),
  )

  it.effect("resolves context and model concurrently after prompt promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = []
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Establish context" }), resume: false })
      yield* session.resume(sessionID)

      const gate = yield* Deferred.make<void>()
      const started: string[] = []
      systemLoadHook = Effect.sync(() => started.push("context")).pipe(Effect.andThen(Deferred.await(gate)))
      modelResolveHook = Effect.sync(() => started.push("model")).pipe(Effect.andThen(Deferred.await(gate)))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run concurrently" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      for (let attempt = 0; attempt < 500 && started.length < 2; attempt += 1) yield* Effect.yieldNow
      const beforeRelease = [...started]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)
      systemLoadHook = Effect.void
      modelResolveHook = Effect.void

      expect(new Set(beforeRelease)).toEqual(new Set(["context", "model"]))
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("names a placeholder session in the background after its opening turn", () =>
    Effect.gen(function* () {
      yield* setup
      const untitled = SessionV2.ID.make("ses_runner_untitled")
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: untitled,
          project_id: Project.ID.global,
          slug: untitled,
          directory: testDirectory,
          title: SessionCreation.placeholderTitle(0),
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // The shipped registry, so the request that goes out carries the hidden `title` agent's own
      // prompt rather than anything this test invented.
      const agents = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Location.Service, Location.Service.of(locationFixture({ directory: testDirectory }))),
      )
      generated = LLMResponse.fromEvents([
        LLMEvent.textStart({ id: "blk_title" }),
        LLMEvent.textDelta({ id: "blk_title", text: "Safari redirect loop" }),
        LLMEvent.textEnd({ id: "blk_title" }),
        LLMEvent.finish({ reason: "stop" }),
      ])
      response = []

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: untitled, prompt: Prompt.make({ text: "why does Safari redirect twice" }) })
      while (requests.length < 1) yield* Effect.yieldNow

      // The turn had already streamed and returned; the title is still catching up behind it.
      expect(requests).toHaveLength(1)
      expect(yield* settledTitle(untitled)).toBe("Safari redirect loop")
      expect(generateRequests).toHaveLength(1)
      expect(generateRequests[0]!.system.map((part) => part.text)[0]).toStartWith("You are a title generator.")
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "echo",
        "defect",
        "slow",
        "approval",
        "get_goal",
        "create_goal",
        "update_goal",
        "reflection_read",
        "reflection_state",
        "reflection_complete",
        "bash",
        "shell_job",
        "harness_review_request",
        "handoff_session",
      ])
      const reviewTool = requests[0]?.tools.find((tool) => tool.name === "harness_review_request")
      expect(reviewTool?.inputSchema).toMatchObject({
        type: "object",
        properties: { request: { type: "string" } },
        required: ["request"],
      })
      expect(reviewTool && "$ref" in reviewTool.inputSchema).toBe(false)
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("keeps the request prefix and baseline stable across real reflection_state updates", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const reflection = yield* Reflection.Service
      const database = yield* Database.Service
      const states = [
        {
          prediction: "The check will pass",
          hypotheses: [{ claim: "Prefix stays stable", status: "open" }],
          next_action: "Run the check",
        },
        {
          prediction: "The check passed",
          hypotheses: [
            { claim: "Prefix stays stable", status: "supported", evidence: "Requests retained their prefix" },
          ],
          next_action: "Report the result",
        },
      ]
      const snapshots = []
      for (const [index, state] of states.entries()) {
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: `reflection-state-${index}`, name: "reflection_state", input: state }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          fragmentFixture("text", `reflection-state-done-${index}`, ["State recorded"]).completeEvents,
        ]
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Record work state ${index}` }), resume: false })
        yield* session.resume(sessionID)
        expect(yield* reflection.work(sessionID)).toMatchObject({
          prediction: state.prediction,
          hypotheses: state.hypotheses,
          nextAction: state.next_action,
        })
        expect(yield* reflection.resetPending(sessionID)).toBe(false)
        const frame = yield* database.db
          .select()
          .from(SessionContextRequestTable)
          .where(eq(SessionContextRequestTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(frame?.generation).toBe(1)
        snapshots.push(
          yield* database.db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, sessionID))
            .get()
            .pipe(Effect.orDie),
        )
      }
      expect(requests).toHaveLength(4)
      requests.slice(1).forEach((request, index) => expectStablePrefix(requests[index]!, request))
      expect(snapshots[0]).toBeDefined()
      expect(snapshots[1]).toEqual(snapshots[0])
      const tools = (yield* session.messages({ sessionID })).flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      )
      expect(tools).toHaveLength(2)
      expect(tools.every((tool) => tool.name === "reflection_state" && tool.state.status === "completed")).toBe(true)
    }),
  )

  it.effect("does not prune adopted history when initial and reconfigured frames are below 75 percent", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const history = yield* adoptPrunableHistory
      currentModel = Model.make({
        id: "roomy",
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 1_000 } }),
      })
      for (const index of [0, 1]) {
        if (index === 1)
          currentModel = Model.make({
            id: "roomy-reconfigured",
            provider: "fake",
            route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 1_000 } }),
          })
        response = fragmentFixture("text", `adopted-done-${index}`, ["Done"]).completeEvents
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Current request ${index}` }), resume: false })
        yield* session.resume(sessionID)
        const request = requests[index]!
        const wire = JSON.stringify(request.messages)
        history.outputs.forEach((output) => expect(wire).toContain(output))
        expect(wire.split(history.outputs[0]!).length - 1).toBe(2)
        expect(wire).toContain(history.input.content)
        expect(wire).not.toContain(SessionCompaction.PRUNED_TEXT)
        expect(wire).not.toContain(SessionCompaction.PRUNED_DUPLICATE_TEXT)
        expect(wire).not.toContain(SessionCompaction.PRUNED_INPUT_TEXT)
        const row = yield* database.db
          .select()
          .from(SessionContextRequestTable)
          .where(eq(SessionContextRequestTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(row).toMatchObject({ generation: index + 1, reason: index === 0 ? "initial" : "configuration" })
        const frame = yield* Schema.decodeUnknownEffect(SessionContextRequest.Frame)(row!.data)
        expect(SessionCompaction.needsPruning({ entries: frame.entries, model: currentModel, request })).toBe(false)
      }
      expect(requests).toHaveLength(2)
      expect((yield* session.messages({ sessionID })).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect(
    "prunes at 75 percent cached occupancy before the next provider call without summarizing or replaying",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const database = yield* Database.Service
        const history = yield* adoptPrunableHistory
        currentModel = Model.make({
          id: "cached-pressure",
          provider: "fake",
          route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 1_000 } }),
        })
        const executionCount = executions.length
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "pressure-work", name: "echo", input: { text: "current protected result" } }),
            LLMEvent.stepFinish({
              index: 0,
              reason: "tool-calls",
              usage: {
                inputTokens: 750_000,
                nonCachedInputTokens: 1_000,
                cacheReadInputTokens: 749_000,
                outputTokens: 0,
              },
            }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          fragmentFixture("text", "pressure-done", ["Finished without a summary"]).completeEvents,
        ]
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Protect this current user request" }),
          resume: false,
        })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(2)
        expect(responses).toHaveLength(0)
        expect(executions.slice(executionCount)).toEqual(["current protected result"])
        expect(requests[1]!.system).toEqual(requests[0]!.system)
        expect(JSON.stringify(requests[0]!.messages)).toContain(history.outputs[2]!)
        expect(JSON.stringify(requests[0]!.messages)).not.toContain(SessionCompaction.PRUNED_TEXT)
        const wire = JSON.stringify(requests[1]!.messages)
        expect(wire).toContain(SessionCompaction.PRUNED_TEXT)
        expect(wire).not.toContain(history.outputs[2]!)
        expect(wire).toContain("current protected result")
        expect(userTexts(requests[1]!)).toContain("Protect this current user request")
        const row = yield* database.db
          .select()
          .from(SessionContextRequestTable)
          .where(eq(SessionContextRequestTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(row).toMatchObject({ generation: 2, reason: "pressure" })
        const frame = yield* Schema.decodeUnknownEffect(SessionContextRequest.Frame)(row!.data)
        expect(frame.messages).toEqual(requests[1]!.messages)
        expect(
          frame.entries
            .filter((entry) => entry.message.type === "assistant")
            .every((entry) => entry.message.type === "assistant" && entry.message.tokens === undefined),
        ).toBe(true)
        expect(
          SessionCompaction.needsPruning({ entries: frame.entries, model: currentModel, request: requests[1]! }),
        ).toBe(false)
        const durable = yield* session.messages({ sessionID })
        const raw = JSON.stringify(durable)
        history.outputs.forEach((output) => expect(raw).toContain(output))
        expect(durable.some((message) => message.type === "compaction")).toBe(false)
        expect(durable.some((message) => message.type === "assistant" && message.tokens?.cache.read === 749_000)).toBe(
          true,
        )
      }),
  )

  it.effect("runs a due reflection inside the worker loop and resets context before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const reflection = yield* Reflection.Service
      const info = yield* session.get(sessionID)
      yield* reflection.recordCompletion({ session: info, interval: 1 })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue with reflection" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-reflection-complete",
            name: "reflection_complete",
            input: {
              critique: "The previous estimate needed an external check.",
              lessons: ["Verify shared changes against their consumers."],
              memories: [],
            },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "reflection-finished", ["Continued after reflection"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(runtimeTexts(requests[0]!).join("\n")).toContain("<reflection_checkpoint>")
      // Completing reflection explicitly resets the epoch and discards its rendered frame.
      expect(runtimeTexts(requests[1]!).join("\n")).not.toContain("<reflection_checkpoint>")
      expect(JSON.stringify(requests[1]!.messages)).not.toContain("<reflection_checkpoint>")
      expect(requests[1]!.system).toEqual(requests[0]!.system)
      expect(yield* reflection.resetPending(sessionID)).toBe(false)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Continue with reflection" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              name: "reflection_complete",
              state: { status: "completed", structured: { completed: true } },
            },
          ],
        },
        { type: "assistant", content: [{ type: "text", text: "Continued after reflection" }] },
      ])
    }),
  )

  it.effect("promotes an admit-only imported report before the user's first follow-up", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const handoff = "Imported analysis result: bounded report"
      const followUp = "Which behavior should I inspect first?"

      yield* session.prompt({
        id: SessionMessage.ID.make("msg_imported_report"),
        sessionID,
        prompt: Prompt.make({ text: handoff }),
        delivery: "steer",
        resume: false,
      })

      expect(requests).toHaveLength(0)
      expect(yield* session.messages({ sessionID })).toHaveLength(0)

      response = []
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: followUp }) })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual([handoff, followUp])
      expect(
        (yield* session.messages({ sessionID })).flatMap((message) => (message.type === "user" ? [message.text] : [])),
      ).toEqual(expect.arrayContaining([handoff, followUp]))
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }) })
      yield* session.resumePending(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("bounds context update tails without compacting conversation or deleting replay events", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      response = fragmentFixture("text", "context-answer", ["Original answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Original question" }), resume: false })
      yield* session.resume(sessionID)
      response = []
      for (let index = 1; index <= 34; index++) {
        systemBaseline = `Context revision ${index}`
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Question ${index}` }), resume: false })
        yield* session.resume(sessionID)
        expect(requests.at(-1)!.messages.filter((message) => message.role === "system").length).toBeLessThanOrEqual(16)
      }

      const request = requests.at(-1)!
      expect(request.system.map((part) => part.text)).toEqual([defaultPrompt, "Context revision 34"])
      expect(request.messages.filter((message) => message.role === "system")).toHaveLength(0)
      expect(request.messages.filter((message) => message.role === "user")).toHaveLength(35)
      expect(request.messages.find((message) => message.role === "assistant")?.content).toContainEqual({
        type: "text",
        text: "Original answer",
      })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.type, "session.next.context.updated.1")).all(),
      ).toHaveLength(32)
      const messages = yield* session.messages({ sessionID })
      expect(messages.filter((message) => message.type === "system")).toHaveLength(32)
      expect(messages.some((message) => message.type === "compaction")).toBe(false)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toEqual(messages)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After replay" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([defaultPrompt, "Context revision 34"])
      expect(requests.at(-1)?.messages.filter((message) => message.role === "system")).toHaveLength(0)
    }),
  )

  it.effect("defers context tail folding while unavailable and still reconciles available sources", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Initial skills")
      response = []
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.resume(sessionID)
      for (let index = 1; index <= 16; index++) {
        systemBaseline = `Context revision ${index}`
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Question ${index}` }), resume: false })
        yield* session.resume(sessionID)
      }
      systemUnavailable = true
      skillBaselines.set(AgentV2.ID.make("build"), "Changed skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Unavailable" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        defaultPrompt,
        "Initial context\n\nInitial skills",
      ])
      expect(systemTexts(requests.at(-1)!)).toContain("Context revision 16")
      expect(systemTexts(requests.at(-1)!)).toContain("Changed skills")

      systemUnavailable = false
      skillBaselines.clear()
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recovered" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([defaultPrompt, "Context revision 16"])
      expect(requests.at(-1)?.messages.filter((message) => message.role === "system")).toHaveLength(0)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
    }),
  )

  // The default agent ships without a `system` precisely so the model's own prompt is used. These
  // read the shipped `.txt` off disk rather than restating it, so an emptied, renamed, or unbundled
  // prompt file fails here instead of passing against a string this file made up.
  const shippedPrompt = (name: string) =>
    fs.readFileSync(path.resolve(import.meta.dirname, "../src/session/provider-prompt", `${name}.txt`), "utf8")

  for (const [modelID, providerID, file] of [
    ["claude-sonnet-4-5-20250929", "anthropic", "anthropic"],
    ["gpt-5-codex", "openai", "codex"],
    ["gemini-2.5-pro", "google", "gemini"],
  ] as const) {
    it.effect(`sends the ${file} prompt for ${modelID} when the agent has no system`, () =>
      Effect.gen(function* () {
        yield* setup
        currentModel = Model.make({ id: modelID, provider: providerID, route: OpenAIChat.route })
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

        requests.length = 0
        response = fragmentFixture("text", `text-${file}`, ["Done"]).completeEvents
        yield* session.resume(sessionID)

        const parts = requests.at(-1)?.system.map((part) => part.text)
        expect(parts?.[0]).toBe(shippedPrompt(file))
        expect(parts).toEqual([shippedPrompt(file), "Initial context"])
      }),
    )
  }

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context\n\nBuild skills"],
        [defaultPrompt, "Initial context\n\nBuild skills"],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context\n\nBuild skills"],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context"],
      ])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Initial context"],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Replacement context"],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", [compactionSummary("Preserve the task")]).completeEvents,
        compactionLedger("/first/segment/path.ts holds the port"),
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      // Summary, fact extraction, then the rebuilt turn.
      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0])[0]).toContain("## Objective")
      expect(userTexts(requests[1])[0]).toContain("Extract every durable, checkable fact")
      // Checkpoint plus the continuation directive: the checkpoint disclaims
      // being an instruction, so the rebuilt request must explicitly mark the
      // turn as resumable or the model stops and asks what to do next.
      expect(userTexts(requests[2])).toHaveLength(3)
      expect(userTexts(requests[2])[0]).toContain(`<summary>\n${compactionSummary("Preserve the task")}\n</summary>`)
      expect(userTexts(requests[2])[0]).toContain("<durable-facts>\n")
      expect(userTexts(requests[2])[0]).toContain("- /first/segment/path.ts holds the port")
      expect(userTexts(requests[2])[1]).toContain("Recent exact request")
      expect(userTexts(requests[2])[2]).toContain("Resume immediately")

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "user", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: compactionSummary("Preserve the task"),
        ledger: ["- /first/segment/path.ts holds the port"],
      })

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", [compactionSummary("Preserve the updated task")]).completeEvents,
        compactionLedger("/second/segment/path.ts holds the retry"),
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0])[0]).toContain(
        `<previous-summary>\n${compactionSummary("Preserve the task")}\n</previous-summary>`,
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      // The ledger is never fed back into summarization: it is carried, not re-summarized.
      expect(userTexts(requests[0])[0]).not.toContain("/first/segment/path.ts holds the port")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: compactionSummary("Preserve the updated task"),
        // Generation two appends to generation one's line rather than replacing it.
        ledger: ["- /first/segment/path.ts holds the port", "- /second/segment/path.ts holds the retry"],
      })
    }),
  )

  it.effect("compacts on demand well below the automatic budget", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = recoveryModel
      response = fragmentFixture("text", "manual-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)

      requests.length = 0
      response = fragmentFixture("text", "manual-summary", [compactionSummary("Compact on request")]).completeEvents
      yield* session.compact({ sessionID })

      // A handful of tokens against a 20k window: `compactIfNeeded` would never have fired here,
      // which is the whole point of the manual trigger. Two calls: summary, then extraction.
      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("Output exactly the Markdown structure")
      expect(userTexts(requests[1])[0]).toContain("Extract every durable, checkable fact")
      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        reason: "manual",
        summary: compactionSummary("Compact on request"),
      })
    }),
  )

  it.effect("reports a failed manual compaction instead of silently doing nothing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = recoveryModel
      response = fragmentFixture("text", "manual-fail-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)

      response = [LLMEvent.providerError({ message: "summary unavailable" })]
      const failed = yield* session.compact({ sessionID }).pipe(Effect.exit)
      expect(failed).toMatchObject({ _tag: "Failure" })
      expect(Exit.isFailure(failed) ? Cause.squash(failed.cause) : undefined).toMatchObject({
        _tag: "SessionCompaction.FailedError",
        reason: "providerFailed",
      })
      expect(
        (yield* (yield* SessionStore.Service).context(sessionID)).some((message) => message.type === "compaction"),
      ).toBe(false)
      const row = yield* (yield* Database.Service).db
        .select({
          status: SessionTable.status,
          status_owner: SessionTable.status_owner,
          time_compacting: SessionTable.time_compacting,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({ status: "idle", status_owner: null, time_compacting: null })

      // An empty transcript is a distinct refusal, not the same opaque failure.
      yield* insertSession(otherSessionID)
      const empty = yield* session.compact({ sessionID: otherSessionID }).pipe(Effect.exit)
      expect(Exit.isFailure(empty) ? Cause.squash(empty.cause) : undefined).toMatchObject({
        _tag: "SessionCompaction.FailedError",
        reason: "emptyConversation",
      })
    }),
  )

  it.effect("kill-all interrupts a stalled manual compaction and releases the session", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = recoveryModel
      response = fragmentFixture("text", "manual-cancel-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)

      requests.length = 0
      response = fragmentFixture("text", "manual-cancel-summary", [compactionSummary("Never committed")]).completeEvents
      const gate = yield* Deferred.make<void>()
      streamGate = gate
      const compact = yield* session.compact({ sessionID }).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      expect(yield* session.interruptAll()).toEqual({ interrupted: 1, failed: 0 })

      expect(yield* Fiber.await(compact)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      const row = yield* (yield* Database.Service).db
        .select({ status: SessionTable.status, time_compacting: SessionTable.time_compacting })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({ status: "idle", time_compacting: null })
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("refuses to compact a session with a provider turn in flight", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = recoveryModel
      response = fragmentFixture("text", "manual-busy", ["Answer"]).completeEvents
      const gate = yield* Deferred.make<void>()
      streamGate = gate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hold the turn open" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow

      const busy = yield* session.compact({ sessionID }).pipe(Effect.exit)
      expect(Exit.isFailure(busy) ? Cause.squash(busy.cause) : undefined).toMatchObject({
        _tag: "SessionCompaction.FailedError",
        reason: "sessionBusy",
      })
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(run)
      streamGate = undefined
    }),
  )

  it.effect("preserves hidden goal continuation context across automatic compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "goal-compact-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier goal context ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      response = fragmentFixture("text", "goal-compact-recent", ["Recent answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent goal context ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Finish the durable goal after compaction"),
      })
      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "goal-compact-summary", [compactionSummary("Preserve the active goal")]).completeEvents,
        compactionLedger("the goal survives compaction"),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-compact-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-compact-final", ["Compacted goal complete"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests.length).toBeGreaterThanOrEqual(3)
      expect(userTexts(requests[0]!)[0]).toContain("## Objective")
      const continuation = requests.find((request) =>
        userTexts(request).some((text) => text.includes("<anti_drift_reminder>")),
      )
      expect(continuation).toBeDefined()
      expect(userTexts(continuation!).at(-1)).toContain("Finish the durable goal after compaction")
      expect(
        (yield* session.context(sessionID)).some(
          (message) => message.type === "synthetic" && message.text.includes("<anti_drift_reminder>"),
        ),
      ).toBe(false)
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "complete" })
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", [compactionSummary("Recover overflow")]).completeEvents,
        compactionLedger("the overflow was recovered once"),
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      // Overflowing turn, summary, fact extraction, retried turn.
      expect(requests).toHaveLength(4)
      expect(userTexts(requests[1])[0]).toContain("## Objective")
      expect(userTexts(requests[3])[0]).toContain(`<summary>\n${compactionSummary("Recover overflow")}\n</summary>`)
      expect(userTexts(requests[3])[0]).toContain("- the overflow was recovered once")
      expect(userTexts(requests[3]).at(-1)).toContain("Resume immediately")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: compactionSummary("Recover overflow") },
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", [compactionSummary("Recover once")]).completeEvents,
        compactionLedger("recovery ran once"),
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(4)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", [compactionSummary("Recover raw overflow")]).completeEvents,
        compactionLedger("the raw overflow was recovered"),
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(4)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: compactionSummary("Recover raw overflow") },
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("checkpoints the session itself when recovery summarization keeps failing", () =>
    Effect.gen(function* () {
      // The escape hatch of last resort. A session whose history no longer fits and whose model
      // cannot summarize it used to be unrecoverable — every turn overflowed, every recovery
      // failed, and `/compact` failed identically. One summarization attempt per bounded retry,
      // then TurenOS writes the checkpoint itself from the history it already has.
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
        fragmentFixture("text", "text-after-fallback", ["Answer after the fallback checkpoint"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const checkpoint = context.find((message) => message.type === "compaction")
      expect(checkpoint).toBeDefined()
      expect(checkpoint).toMatchObject({ summary: expect.stringContaining("written by TurenOS, not by a model") })
      // The turn the overflow blocked now runs on the compacted context.
      expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
    }),
  )

  it.effect("publishes the original overflow when there is too little history to rescue", () =>
    Effect.gen(function* () {
      // The fallback is a rescue, not a policy: below the keep budget there is nothing a mechanical
      // checkpoint could free, so replacing the history with an excerpt would destroy a healthy
      // transcript and hide a real provider failure. The user sees the provider's own error.
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-tiny", ["Ok"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      yield* session.resume(sessionID)
      currentModel = recoveryModel
      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      // One turn plus one summarization attempt per bounded retry: a failure that produced no
      // summary earns a smaller prompt whatever the provider called it.
      expect(requests).toHaveLength(4)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("settles a raw defect during overflow recovery and pauses the active goal", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Recover if overflow summarization itself fails"),
      })
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === SessionEvent.Compaction.Started.type
          ? Effect.sync(() => {
              responseStream = Stream.die(new RangeError("Maximum call stack size exceeded"))
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      response = [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", error: { message: expect.stringContaining("Maximum call stack size exceeded") } },
      ])
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "paused" })
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Keep the goal resumable after an interruption"),
      })
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", [compactionSummary("Interrupted")]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "active" })
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([defaultPrompt, "Initial context"])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "echo",
        "defect",
        "slow",
        "approval",
        "get_goal",
        "create_goal",
        "update_goal",
        "reflection_read",
        "reflection_state",
        "reflection_complete",
        "bash",
        "shell_job",
        "harness_review_request",
        "handoff_session",
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues after malformed provider tool JSON without executing the tool", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-malformed", name: "echo" }),
          LLMEvent.toolInputDelta({ id: "call-malformed", name: "echo", text: '{"text":"unterminated' }),
          LLMEvent.toolInputEnd({ id: "call-malformed", name: "echo" }),
          LLMEvent.toolError({
            id: "call-malformed",
            name: "echo",
            message: "Invalid JSON input. Regenerate this tool call with valid JSON.",
            recoverable: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "after-malformed", ["Recovered without executing malformed input"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover malformed tool JSON" }), resume: false })

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(executions).toEqual([])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover malformed tool JSON" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-malformed",
              state: { status: "error", error: { message: expect.stringContaining("Regenerate this tool call") } },
            },
          ],
        },
        { type: "assistant", content: [{ type: "text", text: "Recovered without executing malformed input" }] },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultPrompt, "Initial context"],
        [defaultPrompt, "Initial context"],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  // Advance only once every tool in the expected wave has entered. This tests actual
  // sleep duration and concurrency without including unrelated CI scheduling delays.
  const slowCalls = (count: number) => [
    LLMEvent.stepStart({ index: 0 }),
    ...Array.from({ length: count }, (_, index) =>
      LLMEvent.toolCall({ id: `call-slow-${index}`, name: "slow", input: { text: `${index}` } }),
    ),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
  const finalTurn = [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
  const slowDelayMs = Duration.toMillis(SLOW_TOOL_DELAY)

  it.effect("settles independent tool calls from one assistant message in max, not sum, of their durations", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Probe six places" }), resume: false })

      requests.length = 0
      executions.length = 0
      response = []
      responses = [slowCalls(6), finalTurn]

      toolExecutionsReady = 6
      toolExecutionsStarted = yield* Deferred.make<void>()
      const started = yield* Clock.currentTimeMillis
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* TestClock.adjust(slowDelayMs - 1)
      expect(activeToolExecutions).toBe(6)
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(run)
      const elapsed = (yield* Clock.currentTimeMillis) - started

      expect(executions).toHaveLength(6)
      expect(maxActiveToolExecutions).toBe(6)
      expect(elapsed).toBe(slowDelayMs)
      // Completion order is irrelevant to the transcript: parts are created when the call is
      // announced and settled in place by call id, so the model sees the model's own ordering.
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Probe six places" },
        {
          type: "assistant",
          content: Array.from({ length: 6 }, (_, index) => ({
            type: "tool",
            id: `call-slow-${index}`,
            state: { status: "completed", input: { text: `${index}` } },
          })),
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("bounds the fan-out of one assistant message rather than forking every call at once", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const oversized = SessionRunnerLLM.TOOL_CONCURRENCY_LIMIT + 4
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Probe everywhere" }), resume: false })

      requests.length = 0
      executions.length = 0
      response = []
      responses = [slowCalls(oversized), finalTurn]

      toolExecutionsReady = SessionRunnerLLM.TOOL_CONCURRENCY_LIMIT
      toolExecutionsStarted = yield* Deferred.make<void>()
      const started = yield* Clock.currentTimeMillis
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* TestClock.adjust(slowDelayMs - 1)
      expect(executions).toHaveLength(SessionRunnerLLM.TOOL_CONCURRENCY_LIMIT)
      expect(activeToolExecutions).toBe(SessionRunnerLLM.TOOL_CONCURRENCY_LIMIT)
      expect(requests).toHaveLength(1)

      toolExecutionsReady = oversized
      toolExecutionsStarted = yield* Deferred.make<void>()
      yield* TestClock.adjust(1)
      yield* Deferred.await(toolExecutionsStarted)
      yield* TestClock.adjust(slowDelayMs - 1)
      expect(activeToolExecutions).toBe(4)
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(run)
      const elapsed = (yield* Clock.currentTimeMillis) - started

      expect(executions).toHaveLength(oversized)
      expect(maxActiveToolExecutions).toBe(SessionRunnerLLM.TOOL_CONCURRENCY_LIMIT)
      expect(elapsed).toBe(slowDelayMs * 2)
      expect(requests).toHaveLength(2)
    }),
  )

  it.live("keeps a call awaiting user approval from blocking its independent siblings", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      approvalGate = yield* Deferred.make<void>()
      approvalPrompted = yield* Deferred.make<void>()
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask and read" }), resume: false })

      requests.length = 0
      executions.length = 0
      response = []
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-approval", name: "approval", input: { text: "needs-approval" } }),
          LLMEvent.toolCall({ id: "call-sibling-0", name: "echo", input: { text: "sibling-0" } }),
          LLMEvent.toolCall({ id: "call-sibling-1", name: "echo", input: { text: "sibling-1" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        finalTurn,
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(approvalPrompted)
      // The prompt is outstanding and nothing has answered it, yet the two independent reads have
      // already run: an approval in a batch neither deadlocks the batch nor auto-approves itself.
      for (let attempt = 0; attempt < 500 && executions.length < 3; attempt += 1) yield* Effect.yieldNow
      expect(executions).toContain("sibling-0")
      expect(executions).toContain("sibling-1")
      expect(
        (yield* session.context(sessionID)).at(1)?.type === "assistant"
          ? ((yield* session.context(sessionID)).at(1) as SessionMessage.Assistant).content.map((part) =>
              part.type === "tool" ? { id: part.id, status: part.state.status } : { id: "", status: part.type },
            )
          : [],
      ).toMatchObject([
        { id: "call-approval", status: "running" },
        { id: "call-sibling-0", status: "completed" },
        { id: "call-sibling-1", status: "completed" },
      ])

      yield* Deferred.succeed(approvalGate, undefined)
      yield* Fiber.join(run)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask and read" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-approval", state: { status: "completed" } },
            { type: "tool", id: "call-sibling-0", state: { status: "completed" } },
            { type: "tool", id: "call-sibling-1", state: { status: "completed" } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input one per boundary after tool calls", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-one", name: "echo", input: { text: "one" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-two", name: "echo", input: { text: "two" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Steer before next queued input" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Also steer before next queued input" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerRejected()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener interrupts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) => (event.type === SessionEvent.Prompted.type ? Effect.interrupt : Effect.void))
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run interrupted promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run interrupted promotion"])
    }),
  )

  it.effect("settles a committed promotion interrupted as post-commit listeners finish", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const listenerEntered = yield* Deferred.make<void>()
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type
          ? Deferred.succeed(listenerEntered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt committed promotion" }),
        resume: false,
      })

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(listenerEntered)
      yield* session.interrupt(sessionID)

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt committed promotion" },
        { type: "assistant", error: { message: "Provider turn interrupted before it started" } },
      ])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("wakes a different session while the first provider stream is pending", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Wake second" }) })
      while (requests.length < 2) yield* Effect.yieldNow

      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerRejected()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns policy-blocked tools to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call blocked" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-blocked", name: "blocked", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call declined" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call corrected" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-corrected", name: "corrected", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("a steered prompt dismisses the pending question instead of waiting behind it", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      // Typing over the question: the steer must resolve the stalemate, not
      // sit unpromoted behind a turn parked on the dock.
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do this instead" }), resume: true })
      expect(yield* questions.list()).toEqual([])
      const exit = yield* Fiber.join(run)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a joined resume without waiting for the provider drain to finish", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably settles a promoted prompt interrupted before the provider starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const resolving = yield* Deferred.make<void>()
      modelResolveHook = Effect.andThen(Deferred.succeed(resolving, undefined), Effect.never)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt preparation" }), resume: false })

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(resolving)
      yield* session.interrupt(sessionID)

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt preparation" },
        {
          type: "assistant",
          error: { message: "Provider turn interrupted before it started" },
        },
      ])
    }),
  )

  it.effect("durably records a provider turn interrupted before the first content frame", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt pre-content" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      // The provider request was real and the prompt was consumed, but the publisher never opened
      // the step (no content frame arrived), so its failure-reporting handoff never became real:
      // the run-level settlement must record the turn rather than let the interrupt vanish
      // between the two reporters.
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt pre-content" },
        { type: "assistant", error: { message: "Provider turn interrupted before it started" } },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner
        .run({ sessionID, force: true, control: SessionExecutionControl.noop })
        .pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-terminal", name: "echo", input: { text: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("skips tool materialization for an explicitly no-tools agent", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.tools = false
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Answer without tools" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = [fragmentFixture("text", "no-tools-response", ["No tools used"]).completeEvents]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools).toEqual([])
      expect(requests[0]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual([])
    }),
  )

  it.effect("starts a fresh tools-enabled logical turn after a goal reaches the agent step boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Continue across bounded agent turns"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-step-one", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "goal-step-limit" }),
          LLMEvent.textDelta({ id: "goal-step-limit", text: "Logical turn wrapped" }),
          LLMEvent.textEnd({ id: "goal-step-limit" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-after-limit", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-after-complete", ["Completed"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(4)
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[2]?.tools.map((tool) => tool.name)).toContain("update_goal")
      expect(requests[2]?.toolChoice).toBeUndefined()
      expect(userTexts(requests[2]!).at(-1)).toContain("<anti_drift_reminder>")
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "complete" })
    }),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  // A provider mapping that breaks the event contract fails the drain with a defect,
  // not a typed LLMError. Nothing used to settle the turn, so the assistant message
  // and its tool call stayed pending forever in the UI and the only trace was an
  // ERROR in the server log.
  it.effect("settles the turn when the provider stream dies with a defect", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Break the contract" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "toolu_defect", name: "Bash" }),
        LLMEvent.toolCall({ id: "toolu_defect", name: "Bash", input: {}, providerExecuted: true }),
        // Duplicate: `tool-call` already closed the input.
        LLMEvent.toolInputEnd({ id: "toolu_defect", name: "Bash" }),
      ]

      yield* session.resume(sessionID).pipe(Effect.exit)

      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Break the contract" },
        { type: "assistant", finish: "error" },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects exhausted raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      streamFailure = failure

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* statusRow(sessionID)).status !== "retry") yield* Effect.yieldNow
      yield* TestClock.adjust(30_000)
      expect(yield* Fiber.join(running).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(SessionRunnerRetry.MAX_STREAM_ATTEMPTS + 1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  it.effect("continues an active goal without admitting hidden loop prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const objective = SessionGoal.Objective.make("Implement and verify the durable goal loop")
      const messageID = SessionMessage.ID.create()
      yield* goals.create({ sessionID, objective, messageID })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "goal-progress" }),
          LLMEvent.textDelta({ id: "goal-progress", text: "Progress made" }),
          LLMEvent.textEnd({ id: "goal-progress" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: {
              inputTokens: 10,
              nonCachedInputTokens: 8,
              cacheReadInputTokens: 2,
              outputTokens: 4,
              reasoningTokens: 1,
            },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 5,
              nonCachedInputTokens: 4,
              cacheReadInputTokens: 1,
              outputTokens: 1,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "goal-finished" }),
          LLMEvent.textDelta({ id: "goal-finished", text: "Goal complete" }),
          LLMEvent.textEnd({ id: "goal-finished" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* TestClock.adjust(2_200)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(running)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
      )
      const continuation = userTexts(requests[1]!).at(-1)
      expect(continuation).toContain("<anti_drift_reminder>")
      expect(continuation).toContain("internally name the unmet objective requirement")
      expect(continuation).toContain(objective)
      expect(
        userTexts({ ...requests[2]!, messages: requests[2]!.messages.slice(requests[1]!.messages.length) }).some(
          (text) => text.includes("<anti_drift_reminder>"),
        ),
      ).toBe(false)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "user")).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({
        revision: 4,
        status: "complete",
        timeUsedSeconds: 2,
        tokensUsed: 17,
      })
      const turns = yield* db
        .select()
        .from(SessionGoalTurnTable)
        .where(eq(SessionGoalTurnTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(turns).toHaveLength(2)
      expect(turns.reduce((total, turn) => total + turn.token_delta, 0)).toBe(17)
      expect(turns.reduce((total, turn) => total + turn.active_time_ms_delta, 0)).toBe(2_200)
      const completed = (yield* session.context(sessionID))
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool" && part.id === "goal-complete")
      expect(completed).toMatchObject({
        state: {
          status: "completed",
          structured: { goal: { revision: 4, timeUsedSeconds: 2, tokensUsed: 17 } },
        },
      })
    }),
  )

  it.effect("checkpoints usage once before an agent blocks the active goal", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Stop only after a repeated blocker"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-blocked", name: "update_goal", input: { status: "blocked" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 5,
              nonCachedInputTokens: 4,
              cacheReadInputTokens: 1,
              outputTokens: 2,
              reasoningTokens: 1,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-blocked-final", ["Blocked after repeated attempts"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* goals.get(sessionID)).toMatchObject({
        revision: 3,
        status: "blocked",
        tokensUsed: 6,
      })
      const blocked = (yield* session.context(sessionID))
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool" && part.id === "goal-blocked")
      expect(blocked).toMatchObject({
        state: {
          status: "completed",
          structured: { goal: { revision: 3, status: "blocked", tokensUsed: 6 } },
        },
      })
    }),
  )

  it.effect("waits for a slow sibling tool before checkpointing and terminalizing the goal", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Finish only after every sibling tool settles"),
        messageID: SessionMessage.ID.create(),
      })
      toolExecutionGate = yield* Deferred.make<void>()
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-slow-sibling", name: "echo", input: { text: "slow sibling" } }),
          LLMEvent.toolCall({ id: "goal-after-sibling", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 5,
              nonCachedInputTokens: 4,
              cacheReadInputTokens: 1,
              outputTokens: 2,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-after-sibling-final", ["All sibling work completed"]).completeEvents,
      ]

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* TestClock.adjust(3_400)
      expect(yield* goals.get(sessionID)).toMatchObject({
        revision: 1,
        status: "active",
        tokensUsed: 0,
      })
      yield* Deferred.succeed(toolExecutionGate, undefined)
      toolExecutionGate = undefined
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(yield* goals.get(sessionID)).toMatchObject({
        revision: 3,
        status: "complete",
        timeUsedSeconds: 3,
        tokensUsed: 6,
      })
      const completed = (yield* session.context(sessionID))
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool" && part.id === "goal-after-sibling")
      expect(completed).toMatchObject({
        state: {
          status: "completed",
          structured: { goal: { revision: 3, status: "complete", timeUsedSeconds: 3, tokensUsed: 6 } },
        },
      })
    }),
  )

  it.effect("rejects a model attempt to force the system-owned usageLimited status", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Keep system-owned terminal states out of the model tool"),
        messageID: SessionMessage.ID.create(),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "goal-force-usage-limited",
            name: "update_goal",
            input: { status: "usageLimited" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-valid-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-valid-complete-final", ["Goal completed through an allowed status"])
          .completeEvents,
      ]

      yield* session.resume(sessionID)

      const forced = (yield* session.context(sessionID))
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool" && part.id === "goal-force-usage-limited")
      expect(forced).toEqual([
        expect.objectContaining({
          id: "goal-force-usage-limited",
          state: expect.objectContaining({ status: "error" }),
        }),
      ])
      expect(yield* goals.get(sessionID)).toMatchObject({ revision: 2, status: "complete", tokensUsed: 0 })
    }),
  )

  it.effect("marks an active goal usageLimited after provider quota exhaustion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Stop safely if provider usage is exhausted"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new QuotaExceededReason({ message: "Quota exhausted" }),
      })

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(streamFailure)

      expect(requests).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "usageLimited" })
    }),
  )

  it.effect("pauses an active goal after a terminal provider event without declaring it blocked or retrying", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Stop safely after a terminal provider error"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      response = [LLMEvent.providerError({ message: "Terminal provider failure" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "paused" })
    }),
  )

  it.effect("pauses an active goal after bounded transport retries are exhausted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Preserve the goal across a transient transport failure"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      streamFailure = providerUnavailable()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* statusRow(sessionID)).status !== "retry") yield* Effect.yieldNow
      yield* TestClock.adjust(30_000)
      expect(yield* Fiber.join(running).pipe(Effect.flip)).toBe(streamFailure)

      expect(requests).toHaveLength(SessionRunnerRetry.MAX_STREAM_ATTEMPTS + 1)
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "paused" })
    }),
  )

  it.effect("pauses an active goal after a raw provider defect and permits explicit recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const active = yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Recover after a provider stream stack overflow"),
        messageID: SessionMessage.ID.create(),
      })
      responseStream = Stream.die(new RangeError("Maximum call stack size exceeded"))

      const failed = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(yield* goals.get(sessionID)).toMatchObject({ id: active.id, status: "paused" })

      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-stack-recovery", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-stack-recovered", ["Recovered after the provider defect"]).completeEvents,
      ]
      const paused = yield* goals.get(sessionID)
      yield* session.goal.status({
        sessionID,
        goalID: paused!.id,
        expectedRevision: paused!.revision,
        status: "active",
      })
      for (let attempt = 0; attempt < 200 && (yield* goals.get(sessionID))?.status !== "complete"; attempt += 1)
        yield* Effect.yieldNow
      for (let attempt = 0; attempt < 200 && (yield* session.active).has(sessionID); attempt += 1)
        yield* Effect.yieldNow

      expect(requests).toHaveLength(3)
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "complete" })
    }),
  )

  it.effect("does not retry a raw defect that follows a retryable provider frame", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Expose the raw provider defect" }),
        resume: false,
      })
      responseStream = Stream.concat(
        Stream.fromIterable([LLMEvent.providerError({ message: "Provider overloaded", retryable: true })]),
        Stream.die(new RangeError("Maximum call stack size exceeded")),
      )

      const failed = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        { type: "assistant", error: { message: expect.stringContaining("Maximum call stack size exceeded") } },
      ])
    }),
  )

  it.effect("does not block a replacement goal when an older provider turn fails terminally", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const original = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_terminal_original"),
        objective: SessionGoal.Objective.make("Finish the original goal"),
        messageID: SessionMessage.ID.create(),
      })
      responses = [
        [LLMEvent.providerError({ message: "Old provider turn failed" })],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "goal_replacement_complete",
            name: "update_goal",
            input: { status: "complete" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal_replacement_final", ["Replacement complete"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const completed = yield* goals.status({
        sessionID,
        goalID: original.id,
        expectedRevision: original.revision,
        status: "complete",
      })
      const replacement = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_terminal_replacement"),
        objective: SessionGoal.Objective.make("Finish the replacement goal"),
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(running)
      streamGate = undefined
      streamStarted = undefined

      expect(completed.status).toBe("complete")
      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1]!).at(-1)).toContain(replacement.objective)
      expect(yield* goals.get(sessionID)).toMatchObject({
        id: replacement.id,
        status: "complete",
      })
    }),
  )

  it.effect("does not usage-limit a replacement goal when an older provider turn exhausts quota", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const original = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_quota_original"),
        objective: SessionGoal.Objective.make("Finish the quota-bound original goal"),
        messageID: SessionMessage.ID.create(),
      })
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new QuotaExceededReason({ message: "Old provider quota exhausted" }),
      })
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* goals.status({
        sessionID,
        goalID: original.id,
        expectedRevision: original.revision,
        status: "complete",
      })
      const replacement = yield* goals.create({
        sessionID,
        id: SessionGoal.ID.make("goal_quota_replacement"),
        objective: SessionGoal.Objective.make("Finish the replacement after old quota exhaustion"),
      })
      yield* Deferred.succeed(streamGate, undefined)
      const exit = yield* Fiber.await(running)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit)).toBeTrue()
      expect(requests).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({
        id: replacement.id,
        status: "active",
      })
    }),
  )

  it.effect("promotes steering before goal continuation and queued input at the next boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Respect live goal input ordering"),
        messageID: SessionMessage.ID.create(),
      })
      responses = [
        fragmentFixture("text", "goal-before-steer", ["Initial work"]).completeEvents,
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-steer-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-after-queue", ["Queue handled"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer the active goal" }),
        delivery: "steer",
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Join at the next boundary" }),
        delivery: "queue",
        resume: false,
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(running)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1]!).at(-1)).toBe("Steer the active goal")
      expect(userTexts(requests[1]!).some((text) => text.includes("<anti_drift_reminder>"))).toBe(false)
      expect(userTexts(requests[2]!).at(-1)).toBe("Join at the next boundary")
      expect(yield* goals.get(sessionID)).toMatchObject({ status: "complete" })
    }),
  )

  it.effect("reloads an edited objective before the next automatic tool-result continuation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const original = yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Implement the original objective"),
        messageID: SessionMessage.ID.create(),
      })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-before-edit", name: "echo", input: { text: "before edit" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-edited-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-edited-final", ["Edited goal complete"]).completeEvents,
      ]

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      const edited = yield* goals.edit({
        sessionID,
        goalID: original.id,
        expectedRevision: original.revision,
        objective: SessionGoal.Objective.make("Implement the edited objective instead"),
      })
      yield* Deferred.succeed(toolExecutionGate, undefined)
      toolExecutionGate = undefined
      yield* Fiber.join(running)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1]!).at(-1)).toContain("objective was edited")
      expect(userTexts(requests[1]!).at(-1)).toContain(edited.objective)
      expect(userTexts(requests[1]!).at(-1)).toContain("Internally name the unmet current requirement")
      expect(yield* goals.get(sessionID)).toMatchObject({
        objective: edited.objective,
        status: "complete",
      })
    }),
  )

  it.effect("accounts an in-flight provider turn after an edit and pause advance the goal revision twice", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const active = yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Preserve usage across a concurrent edit and pause"),
        messageID: SessionMessage.ID.create(),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "goal-edit-pause-usage" }),
          LLMEvent.textDelta({ id: "goal-edit-pause-usage", text: "Work completed before pause" }),
          LLMEvent.textEnd({ id: "goal-edit-pause-usage" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: {
              inputTokens: 4,
              nonCachedInputTokens: 4,
              cacheReadInputTokens: 0,
              outputTokens: 3,
              reasoningTokens: 2,
            },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const edited = yield* goals.edit({
        sessionID,
        goalID: active.id,
        expectedRevision: active.revision,
        objective: SessionGoal.Objective.make("Preserve usage after the edited objective"),
      })
      yield* goals.status({
        sessionID,
        goalID: edited.id,
        expectedRevision: edited.revision,
        status: "paused",
      })
      yield* Deferred.succeed(streamGate, undefined)
      streamGate = undefined
      streamStarted = undefined
      yield* Fiber.join(running)

      expect(yield* goals.get(sessionID)).toMatchObject({
        id: active.id,
        revision: 4,
        status: "paused",
        tokensUsed: 7,
      })
    }),
  )

  it.effect("checkpoints active time with zero tokens when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Preserve elapsed work across interruption"),
        messageID: SessionMessage.ID.create(),
      })
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* TestClock.adjust(2_200)
      yield* session.interrupt(sessionID)
      expect(Exit.isFailure(yield* Fiber.await(running))).toBeTrue()
      streamGate = undefined
      streamStarted = undefined

      expect(yield* goals.get(sessionID)).toMatchObject({
        revision: 2,
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 2,
      })
    }),
  )

  it.effect("honors a pause race and resumes the same durable active goal", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const active = yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Pause and resume without losing the goal"),
        messageID: SessionMessage.ID.create(),
      })
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const paused = yield* session.goal.status({
        sessionID,
        goalID: active.id,
        expectedRevision: active.revision,
        status: "paused",
      })
      expect(Exit.isFailure(yield* Fiber.await(running))).toBeTrue()
      expect(requests).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({ id: active.id, status: "paused" })

      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-resumed-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-resumed-final", ["Resumed goal complete"]).completeEvents,
      ]
      const resumed = yield* session.goal.status({
        sessionID,
        goalID: paused.id,
        expectedRevision: paused.revision,
        status: "active",
      })
      yield* session.resume(sessionID)

      expect(resumed.id).toBe(active.id)
      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1]!).at(-1)).toContain("<anti_drift_reminder>")
      expect(yield* goals.get(sessionID)).toMatchObject({ id: active.id, status: "complete" })
    }),
  )

  it.effect("does not charge goal usage while the V2 plan agent is selected", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("plan"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("plan") })
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Plan without consuming execution goal accounting"),
        messageID: SessionMessage.ID.create(),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "goal-plan" }),
          LLMEvent.textDelta({ id: "goal-plan", text: "Plan prepared" }),
          LLMEvent.textEnd({ id: "goal-plan" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: {
              inputTokens: 20,
              nonCachedInputTokens: 20,
              outputTokens: 10,
            },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "goal-plan-complete", name: "update_goal", input: { status: "complete" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "goal-plan-final", ["Planning complete"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* goals.get(sessionID)).toMatchObject({
        status: "complete",
        tokensUsed: 0,
      })
    }),
  )

  it.effect("marks a Plan agent goal usageLimited after provider quota exhaustion without retrying", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("plan"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("plan") })
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Stop Plan mode after provider usage is exhausted"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new QuotaExceededReason({ message: "Quota exhausted" }),
      })

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(streamFailure)

      expect(requests).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({
        status: "usageLimited",
        tokensUsed: 0,
      })
    }),
  )

  it.effect("pauses a Plan agent goal after a terminal provider event without declaring it blocked or retrying", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("plan"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("plan") })
      const goals = yield* SessionGoal.Service
      yield* goals.create({
        sessionID,
        objective: SessionGoal.Objective.make("Stop Plan mode after a terminal provider error"),
        messageID: SessionMessage.ID.create(),
      })
      requests.length = 0
      response = [LLMEvent.providerError({ message: "Terminal provider failure" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toMatchObject({
        status: "paused",
        tokensUsed: 0,
      })
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )
})

/**
 * Provider retry, the session-level one: the wait a person is meant to see.
 *
 * Split deliberately into the two halves the feature has, because they fail
 * independently and each has been shipped without the other in this repository
 * before. The publish half asks whether a rate-limited turn produces a durable
 * `Retried` event and then succeeds; the projection half asks whether replaying
 * that log alone -- no runner, no coordinator, no live process -- reconstructs
 * the waiting status a second viewer would need to see.
 */
describe("SessionRunnerLLM provider retry", () => {
  const retriedEvents = (id: SessionV2.ID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(
          and(eq(EventTable.aggregate_id, id), eq(EventTable.type, EventV2.versionedType("session.next.retried", 1))),
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
    })

  it.effect("publishes a durable Retried notice and completes the turn after the provider's deadline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const failure = yield* executorFailure(afterExecutorRetries(anthropicRateLimited({ "retry-after": "60" })))
      responseStream = Stream.fail(failure)
      responses = [fragmentFixture("text", "after-retry", ["Recovered"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Rate limited" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow

      // Mid-wait: the notice is durable, and the durable status says the turn is waiting rather
      // than stalled. This is the whole point -- a rate limit produces no transcript output at
      // all, so without this a second viewer sees a session doing nothing.
      const notices = yield* retriedEvents(sessionID)
      expect(notices).toHaveLength(1)
      expect(notices[0]!.data).toMatchObject({
        attempt: 1,
        delay: 60_000,
        error: {
          isRetryable: true,
          statusCode: 429,
          responseHeaders: { "retry-after": "60" },
          metadata: { reason: "RateLimit", provider: "fake" },
        },
      })
      const waiting = yield* statusRow(sessionID)
      expect(waiting).toMatchObject({ status: "retry", status_attempt: 1 })
      expect(waiting.status_owner).toBe(SessionStatus.owner)
      expect(waiting.status_message).toContain("429")

      // Nothing has been written to the transcript, so the replay is exactly idempotent.
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([{ type: "user", text: "Rate limited" }])

      yield* TestClock.adjust(60_000)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Rate limited" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
      expect(yield* statusRow(sessionID)).toMatchObject({ status: "idle", status_owner: null, status_attempt: null })
    }),
  )

  it.effect("reconstructs the waiting status from the durable log alone", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Replay the wait" }), resume: false })
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.Retried, {
        sessionID,
        timestamp,
        attempt: 3,
        delay: 45_000,
        error: {
          message: "Provider request failed with HTTP 429",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "45" },
        },
        action: {
          reason: "rate_limit",
          provider: "anthropic",
          title: "Rate limit reached",
          message: "Your workspace has hit its per-minute token limit.",
          label: "View limits",
          link: "https://example.invalid/limits",
        },
      })

      // Drop every projection and rebuild from the event log, the way a cold process or a second
      // node would. If `Retried` is not projected, the status columns come back empty and a
      // reattaching client has no way to learn the turn is waiting.
      yield* replaySessionProjection(sessionID)

      const row = yield* statusRow(sessionID)
      expect(row).toMatchObject({
        status: "retry",
        status_attempt: 3,
        status_message: "Provider request failed with HTTP 429",
        status_next: DateTime.toEpochMillis(timestamp) + 45_000,
      })
      expect(row.status_action).toMatchObject({ provider: "anthropic", label: "View limits" })
      expect(SessionStatus.fromRow(row)).toMatchObject({ type: "retry", attempt: 3 })
    }),
  )

  it.effect("gives up after the attempt bound and settles the turn terminally", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const failure = yield* executorFailure(afterExecutorRetries(anthropicRateLimited({ "retry-after": "1" })))
      streamFailure = failure
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Always limited" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      // One second per attempt, as the provider asked; the bound is what stops it being forever.
      yield* TestClock.adjust(SessionRunnerRetry.MAX_ATTEMPTS * 1_000)
      expect(yield* Fiber.join(running).pipe(Effect.flip)).toBe(failure)

      expect(requests).toHaveLength(SessionRunnerRetry.MAX_ATTEMPTS + 1)
      expect(yield* retriedEvents(sessionID)).toHaveLength(SessionRunnerRetry.MAX_ATTEMPTS)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Always limited" },
        { type: "assistant", finish: "error" },
      ])
      // Terminal failure is durable too, and it replaces the retry countdown rather than
      // leaving a session that claims to be waiting for an attempt nobody will make.
      expect(yield* statusRow(sessionID)).toMatchObject({
        status: "failed",
        status_owner: null,
        status_attempt: null,
        status_next: null,
      })
    }),
  )

  it.effect("abandons the wait when the session is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      streamFailure = yield* executorFailure(afterExecutorRetries(anthropicRateLimited({ "retry-after": "600" })))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt the wait" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow

      yield* Fiber.interrupt(running)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("settles the durable retry status when the wait itself is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      streamFailure = yield* executorFailure(afterExecutorRetries(anthropicRateLimited({ "retry-after": "600" })))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt the wait" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      expect(yield* statusRow(sessionID)).toMatchObject({ status: "retry", status_attempt: 1 })

      yield* session.interrupt(sessionID)
      yield* Fiber.await(running)

      // The wait must settle, not strand: without this the row durably claims "waiting to retry"
      // with a live owner for an attempt nobody will make. The unstarted-interruption record
      // replaces the countdown with a terminal status and leaves no owner behind.
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt the wait" },
        { type: "assistant", error: { message: "Provider turn interrupted before it started" } },
      ])
      expect(yield* statusRow(sessionID)).toMatchObject({
        status: "failed",
        status_owner: null,
        status_attempt: null,
        status_next: null,
      })
    }),
  )

  it.effect("retries a stream-level overload frame without leaving a failed step behind", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = [
        [LLMEvent.providerError({ message: "overloaded_error: Overloaded", retryable: true })],
        fragmentFixture("text", "after-overload", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Overloaded" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(3_000)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Overloaded" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("retries a 200-body transport failure after reasoning-only output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-decode" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-decode", text: "Planning" }),
          LLMEvent.reasoningEnd({ id: "reasoning-before-decode" }),
        ]),
        Stream.fail(providerUnavailable()),
      )
      response = fragmentFixture("text", "after-decode-retry", ["Recovered after body decode failure"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry a broken response body" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(3_000)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry a broken response body" },
        {
          type: "assistant",
          finish: "stop",
          content: [
            { type: "reasoning", text: "Planning" },
            { type: "text", text: "Recovered after body decode failure" },
          ],
        },
      ])
    }),
  )

  it.effect("continues from durable partial text after a response body disconnects", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = streamRecoveryModel
      const session = yield* SessionV2.Service
      const partial = fragmentFixture("text", "text-before-socket-close", ["Partial answer"])
      responseStream = Stream.concat(Stream.fromIterable(partial.partialEvents), Stream.fail(providerSocketClosed()))
      responses = [fragmentFixture("text", "text-after-socket-close", ["Recovered answer"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover partial text" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(3_000)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!).at(-1)).toContain("previous provider stream ended")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover partial text" },
        {
          type: "assistant",
          finish: "error",
          error: { message: expect.stringContaining("UND_ERR_SOCKET") },
          content: [{ type: "text", text: "Partial answer" }],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered answer" }] },
      ])
    }),
  )

  it.effect("fails incomplete tool input as not executed and regenerates on a fresh turn", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = streamRecoveryModel
      const session = yield* SessionV2.Service
      const partial = fragmentFixture("tool input", "call-before-socket-close", ['{"text":"unfinished'])
      const executionCount = executions.length
      responseStream = Stream.concat(Stream.fromIterable(partial.partialEvents), Stream.fail(providerSocketClosed()))
      responses = [
        fragmentFixture("text", "text-after-tool-socket-close", ["Recovered without executing"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover incomplete tool input" }),
        resume: false,
      })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(3_000)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      expect(executions.slice(executionCount)).toEqual([])
      expect(JSON.stringify(requests[1])).toContain("The tool was not executed")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover incomplete tool input" },
        {
          type: "assistant",
          finish: "error",
          content: [
            {
              type: "tool",
              name: "echo",
              state: {
                status: "error",
                error: { message: expect.stringContaining("tool was not executed") },
              },
            },
          ],
        },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "Recovered without executing" }],
        },
      ])
    }),
  )

  it.effect("bounds partial-stream recovery to one fresh continuation", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = streamRecoveryModel
      const session = yield* SessionV2.Service
      const failure = providerSocketClosed()
      const first = fragmentFixture("text", "first-partial-socket-close", ["First partial"])
      const second = fragmentFixture("text", "second-partial-socket-close", ["Second partial"])
      responseStream = Stream.concat(
        Stream.fromIterable(first.partialEvents),
        Stream.fromEffect(
          Effect.sync(() => {
            responseStream = Stream.concat(Stream.fromIterable(second.partialEvents), Stream.fail(failure))
          }).pipe(Effect.andThen(Effect.fail(failure))),
        ),
      )
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Bound stream recovery" }), resume: false })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(3_000)

      expect(yield* Fiber.join(running).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(2)
      expect(yield* retriedEvents(sessionID)).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Bound stream recovery" },
        {
          type: "assistant",
          finish: "error",
          content: [{ type: "text", text: "First partial" }],
        },
        {
          type: "assistant",
          finish: "error",
          content: [{ type: "text", text: "Second partial" }],
        },
      ])
    }),
  )

  it.effect("does not continue a body disconnect after a local tool call was dispatched", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = streamRecoveryModel
      const session = yield* SessionV2.Service
      const failure = providerSocketClosed()
      const executionCount = executions.length
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-terminal-socket-close", name: "echo", input: { text: "once" } }),
        ]),
        Stream.fail(failure),
      )
      responses = [fragmentFixture("text", "must-not-run", ["Unexpected continuation"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not replay executed tools" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["once"])
      expect(yield* retriedEvents(sessionID)).toHaveLength(0)
    }),
  )

  it.effect("does not infer partial-stream recovery safety for an unqualified provider route", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const failure = providerSocketClosed()
      const partial = fragmentFixture("text", "unqualified-route-socket-close", ["Partial answer"])
      responseStream = Stream.concat(Stream.fromIterable(partial.partialEvents), Stream.fail(failure))
      responses = [fragmentFixture("text", "must-not-recover-route", ["Unexpected recovery"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Keep unknown route terminal" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      expect(requests).toHaveLength(1)
      expect(yield* retriedEvents(sessionID)).toHaveLength(0)
    }),
  )

  it.effect("keeps a promoted steer ahead of recovery guidance across compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "stream-recovery-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = streamRecoveryModel
      requests.length = 0
      const partial = fragmentFixture("text", "stream-recovery-before-steer", ["Partial answer"])
      responseStream = Stream.concat(Stream.fromIterable(partial.partialEvents), Stream.fail(providerSocketClosed()))
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })

      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while ((yield* retriedEvents(sessionID)).length < 1) yield* Effect.yieldNow
      currentModel = compactStreamRecoveryModel
      responses = [
        fragmentFixture("text", "stream-recovery-summary", [compactionSummary("Follow the newest steer")])
          .completeEvents,
        compactionLedger("The latest user steer takes priority over stream recovery"),
        fragmentFixture("text", "stream-recovery-after-steer", ["Followed the steer"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Newest steer wins" }) })
      yield* TestClock.adjust(3_000)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(4)
      const recovered = requests[3]!
      expect(runtimeTexts(recovered).some((text) => text.includes("previous provider stream ended"))).toBeTrue()
      expect(userTexts(recovered).some((text) => text.includes("previous provider stream ended"))).toBeFalse()
      expect(userTexts(recovered).some((text) => text.includes("Newest steer wins"))).toBeTrue()
    }),
  )

  it.effect("counts appended runtime guidance after reported usage without double-counting older notes", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const tools = yield* ToolRegistry.Service
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "Verify the change", status: "in_progress", priority: "high" }],
      })
      yield* tools.register({
        todowrite: Tool.make({
          description: "Update the current todo list",
          input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
          output: Schema.Struct({ updated: Schema.Boolean }),
          execute: () => Effect.succeed({ updated: true }),
        }),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "runtime-budget-work", name: "echo", input: { text: "work" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: { inputTokens: 1_000, nonCachedInputTokens: 1_000, outputTokens: 10 },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "runtime-budget-final", ["Ready for review"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish the change" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expectStablePrefix(requests[0]!, requests[1]!)
      const row = yield* database.db
        .select()
        .from(SessionContextRequestTable)
        .where(eq(SessionContextRequestTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeDefined()
      const frame = yield* Schema.decodeUnknownEffect(SessionContextRequest.Frame)(row!.data)
      const budget = frame.entries.at(-1)!.message
      expect(budget.type).toBe("synthetic")
      if (budget.type !== "synthetic") return yield* Effect.die("Missing runtime budget row")
      expect(budget.text).toContain("previous provider turn made substantive progress")
      const overhead = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(budget.text)
      expect(overhead).toEqual(
        requests[1]!.messages.slice(requests[0]!.messages.length).filter((message) => message.role === "system"),
      )
      expect(frame.messages).toEqual(requests[1]!.messages)
      expect(frame.entries.filter((entry) => entry.message.type !== "synthetic")).toHaveLength(frame.sources.length)
      expect((yield* session.messages({ sessionID })).some((message) => message.id === budget.id)).toBe(false)

      const occupancy = SessionCompaction.reportedOccupancy(frame.entries, model)!
      const withoutNotes = SessionCompaction.reportedOccupancy(
        frame.entries.filter((entry) => entry.message.type !== "synthetic"),
        model,
      )!
      expect(withoutNotes).toBeGreaterThanOrEqual(1_010)
      expect(occupancy - withoutNotes).toBeGreaterThan(100)
      // The first turn's note precedes reported usage and must already be absorbed by it.
      expect(frame.entries.filter((entry) => entry.message.type === "synthetic")).toHaveLength(2)
      expect(
        SessionCompaction.reportedOccupancy(
          frame.entries.filter((entry) => entry.message.type !== "synthetic" || entry.message.id === budget.id),
          model,
        ),
      ).toBe(occupancy)
    }),
  )

  it.effect("forces one bounded todo reconciliation turn after work leaves open items stale", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "Verify the completed change", status: "in_progress", priority: "high" }],
      })
      const tools = yield* ToolRegistry.Service
      yield* tools.register({
        todowrite: Tool.make({
          description: "Update the current todo list",
          input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
          output: Schema.Struct({ updated: Schema.Boolean }),
          execute: () => Effect.succeed({ updated: true }),
        }),
      })
      const session = yield* SessionV2.Service
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "todo-stale-work", name: "echo", input: { text: "work" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "todo-stale-follow-up", name: "echo", input: { text: "follow-up" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "todo-stale-third-work", name: "echo", input: { text: "third" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "todo-reconcile-final", ["Work is ready for review"]).completeEvents,
      ]

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish the change" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!).at(-1)).toBe("Finish the change")
      expect(runtimeTexts(requests[0]!).join("\n")).toContain("<todo_checkpoint>")
      expect(runtimeTexts(requests[1]!, requests[0]!).join("\n")).toContain(
        "previous provider turn made substantive progress",
      )
      expect(runtimeTexts(requests[2]!, requests[1]!).join("\n")).not.toContain("<todo_")
      expect(runtimeTexts(requests[3]!, requests[2]!).join("\n")).not.toContain("<todo_")
      requests.slice(1).forEach((request, index) => expectStablePrefix(requests[index]!, request))
      expect(requestSystemTexts(requests[0]!).join("\n")).not.toContain("<todo_")
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "Verify the completed change", status: "in_progress", priority: "high" },
      ])
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("todo_checkpoint")
    }),
  )

  it.effect("reasserts current human intent and todo state after repeated stale board reads", () =>
    Effect.gen(function* () {
      yield* setup
      const task = "Use the issued certificate already in Downloads; do not regenerate the CSR."
      const currentTodo = "Locate and validate the issued Apple certificate"
      const staleBoard = {
        notes: Array.from({ length: 10 }, (_, index) => ({
          title: `Historical runtime audit ${index}`,
          body: `Unrelated completed feature audit ${index}: ${"stale ".repeat(180)}`,
          evidence: `Old evidence ${index}: ${"archive ".repeat(90)}`,
        })),
        total: 10,
      }
      const staleTodos = Array.from({ length: 32 }, (_, index) => ({
        content: `Completed historical task ${index}`,
        status: "completed" as const,
        priority: "low" as const,
      }))
      yield* (yield* SessionTodo.Service).update({
        sessionID,
        todos: [...staleTodos, { content: currentTodo, status: "in_progress", priority: "high" }],
      })
      yield* (yield* ToolRegistry.Service).register({
        board_read: Tool.make({
          description: "Return the deterministic stale board fixture",
          input: Schema.Struct({}),
          output: Schema.Struct({
            notes: Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String, evidence: Schema.String })),
            total: Schema.Number,
          }),
          execute: () => Effect.succeed(staleBoard),
        }),
        todowrite: Tool.make({
          description: "Update the current todo list",
          input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
          output: Schema.Struct({ updated: Schema.Boolean }),
          execute: () => Effect.succeed({ updated: true }),
        }),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "stale-board-first", name: "board_read", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "stale-board-second", name: "board_read", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "stale-board-final", ["Certificate validated"]).completeEvents,
      ]

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: task }), resume: false })
      const { db } = yield* Database.Service
      yield* SessionInput.admit(db, yield* EventV2.Service, {
        id: SessionMessage.ID.make("msg_stale_board_notification"),
        sessionID,
        prompt: Prompt.make({ text: "Historical sibling notification, not the current human task" }),
        delivery: "queue",
        source: "subagent_board",
        kind: "prompt",
        location: (yield* session.get(sessionID)).location,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[1].messages.at(-1)).toMatchObject({
        role: "user",
        metadata: { forge: { internalContext: "current-task" } },
      })
      expect(userTexts(requests[1]).at(-2)).toContain("Historical sibling notification")
      expect(userTexts(requests[1]).at(-1)).toContain(task)
      expect(userTexts(requests[1]).at(-1)).toContain(currentTodo)
      expectStablePrefix(requests[1], requests[2])
      expect(JSON.stringify(requests[2].messages)).not.toContain(
        "[Duplicate result cleared — identical content appears in a later call]",
      )
      expect(userTexts(requests[2]).at(-1)).toContain(currentTodo)
      expect(JSON.stringify(requests[2].messages).match(/Historical runtime audit 0/g)).toHaveLength(2)
      expect(yield* (yield* SessionTodo.Service).get(sessionID)).toContainEqual({
        content: currentTodo,
        status: "in_progress",
        priority: "high",
      })
    }),
  )

  it.effect("keeps a promoted board notification subordinate without a board_read call", () =>
    Effect.gen(function* () {
      yield* setup
      const task = "Finish the current release handoff"
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "notification-echo", name: "echo", input: { value: "checked" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "notification-final", ["Release handoff complete"]).completeEvents,
      ]

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: task }), resume: false })
      const { db } = yield* Database.Service
      yield* SessionInput.admit(db, yield* EventV2.Service, {
        id: SessionMessage.ID.make("msg_standalone_board_notification"),
        sessionID,
        prompt: Prompt.make({ text: "Historical board status, not the current human task" }),
        delivery: "queue",
        source: "subagent_board",
        kind: "prompt",
        location: (yield* session.get(sessionID)).location,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]).at(-2)).toContain("Historical board status")
      expect(userTexts(requests[1]).at(-1)).toContain(task)
      expect(requests[1].messages.at(-1)).toMatchObject({
        role: "user",
        metadata: { forge: { internalContext: "current-task" } },
      })
    }),
  )

  it.effect("stops todo reconciliation after a successful write", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "Replace the old implementation", status: "in_progress", priority: "medium" }],
      })
      const tools = yield* ToolRegistry.Service
      yield* tools.register({
        todowrite: Tool.make({
          description: "Update the current todo list",
          input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
          output: Schema.Struct({ updated: Schema.Boolean }),
          execute: ({ todos: input }, context) =>
            todos.update({ sessionID: context.sessionID, todos: input }).pipe(Effect.as({ updated: true })),
        }),
      })
      const session = yield* SessionV2.Service
      const completed = [
        { content: "Replace the old implementation", status: "completed" as const, priority: "medium" as const },
      ]
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "todo-write", name: "todowrite", input: { todos: completed } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "todo-write-final", ["The implementation is replaced"]).completeEvents,
      ]

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Replace the implementation" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!).at(-1)).toBe("Replace the implementation")
      expect(runtimeTexts(requests[0]!).join("\n")).toContain("<todo_checkpoint>")
      expect(runtimeTexts(requests[1]!, requests[0]!).join("\n")).not.toContain("<todo_")
      expectStablePrefix(requests[0]!, requests[1]!)
      expect(yield* todos.get(sessionID)).toEqual(completed)
    }),
  )

  for (const source of ["subagent_board", "shell_job", "user"] as const)
    it.effect(`only restarts todo guidance for human promotions: ${source}`, () =>
      Effect.gen(function* () {
        yield* setup
        const todos = yield* SessionTodo.Service
        const tools = yield* ToolRegistry.Service
        yield* tools.register({
          todowrite: Tool.make({
            description: "Update the current todo list",
            input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
            output: Schema.Struct({ updated: Schema.Boolean }),
            execute: (input, context) =>
              todos.update({ sessionID: context.sessionID, todos: input.todos }).pipe(Effect.as({ updated: true })),
          }),
        })
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "notification-todo-write",
              name: "todowrite",
              input: { todos: [{ content: "Check the release", status: "in_progress", priority: "high" }] },
            }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "notification-work", name: "echo", input: { value: "checked" } }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          fragmentFixture("text", "notification-todo-final", ["Release checked"]).completeEvents,
        ]
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Check the release" }), resume: false })
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        yield* SessionInput.admit(database.db, events, {
          id: SessionMessage.ID.make(`msg_todo_promotion_${source}`),
          sessionID,
          prompt: Prompt.make({ text: "The release check has an update" }),
          delivery: "queue",
          source,
          kind: "prompt",
          location: (yield* session.get(sessionID)).location,
        })
        yield* session.resume(sessionID)

        expect(requests).toHaveLength(3)
        expect(runtimeTexts(requests[0]!).join("\n")).toContain("<todo_checkpoint>")
        expect(runtimeTexts(requests[1]!, requests[0]!).join("\n").includes("<todo_checkpoint>")).toBe(
          source === "user",
        )
        expect(userTexts(requests[1]!).some((text) => text.includes("The release check has an update"))).toBeTrue()
        expectStablePrefix(requests[0]!, requests[1]!)
        expectStablePrefix(requests[1]!, requests[2]!)
        if (source !== "user") expect(runtimeTexts(requests[2]!, requests[1]!).join("\n")).not.toContain("<todo_")
        if (source === "user")
          expect(runtimeTexts(requests[2]!, requests[1]!).join("\n")).toContain(
            "previous provider turn made substantive progress",
          )
      }),
    )

  it.effect("nudges list creation after work starts without a durable list", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const tools = yield* ToolRegistry.Service
      yield* tools.register({
        todowrite: Tool.make({
          description: "Update the current todo list",
          input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
          output: Schema.Struct({ updated: Schema.Boolean }),
          execute: () => Effect.succeed({ updated: true }),
        }),
      })
      const session = yield* SessionV2.Service
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "todo-create-work", name: "echo", input: { text: "work" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "todo-create-final", ["The work is complete"]).completeEvents,
      ]

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start the multi-step work" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(runtimeTexts(requests[1]!, requests[0]!).join("\n")).toContain("No durable todo list exists yet")
      expect(userTexts(requests[1]!).at(-1)).toBe("Start the multi-step work")
      expect(yield* todos.get(sessionID)).toEqual([])
    }),
  )

  it.effect("keeps a resumed user prompt newer than todo bookkeeping after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "Finish the interrupted task", status: "in_progress", priority: "high" }],
      })
      const tools = yield* ToolRegistry.Service
      yield* tools.register({
        todowrite: Tool.make({
          description: "Update the current todo list",
          input: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
          output: Schema.Struct({ updated: Schema.Boolean }),
          execute: () => Effect.succeed({ updated: true }),
        }),
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start the task" }), resume: false })
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const interrupted = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Answer this instead" }) })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(interrupted)).toMatchObject({ _tag: "Failure" })

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(userTexts(requests[1]!).at(-1)).toBe("Answer this instead")
      expect(userTexts(requests[1]!).join("\n")).not.toContain("<todo_")
      expect(runtimeTexts(requests[1]!, requests[0]!).join("\n")).toContain("<todo_checkpoint>")
      expectStablePrefix(requests[0]!, requests[1]!)
      const suffix = requests[1]!.messages.slice(requests[0]!.messages.length)
      const runtimeIndex = suffix.findIndex((message) => message.role === "system")
      const userIndex = suffix.findIndex((message) => message.role === "user")
      expect(runtimeIndex).toBeGreaterThanOrEqual(0)
      expect(userIndex).toBeGreaterThan(runtimeIndex)
    }),
  )
})
