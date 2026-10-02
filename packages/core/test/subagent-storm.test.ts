// Reproduction rig for the 1.0.37 sidecar OOM: concurrent parent Sessions each
// spawn worker subagents that run a real long-lived `bash` against the turenos
// tree and a real `code_search`. The failure mode under test is per-spawn heap
// retention — between rounds the heap is forced through a full GC and the
// object-type census is recorded so a growing class shows up by name, not just
// as a rising total.

import { describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { fullGC, heapStats } from "bun:jsc"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { eq, notInArray } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { QuestionV2 } from "@turenlabs/core/question"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionGoal } from "@turenlabs/core/session/goal"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionTodo } from "@turenlabs/core/session/todo"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import * as SessionRunnerLLM from "@turenlabs/core/session/runner/llm"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { Reflection } from "@turenlabs/core/reflection"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { ToolBroker } from "@turenlabs/core/tool/broker"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { BashTool } from "@turenlabs/core/tool/bash"
import { CodeSearchTool } from "@turenlabs/core/tool/code-search"
import { ApplicationTools } from "@turenlabs/core/tool/application-tools"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { Snapshot } from "@turenlabs/core/snapshot"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { SessionTaskTable } from "@turenlabs/core/session/task.sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { ReferenceGuidance } from "@turenlabs/core/reference/guidance"
import { ModelV2 } from "@turenlabs/core/model"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SystemContext } from "@turenlabs/core/system-context"
import { CodeSearch } from "@turenlabs/core/search"
import { POTION_MAX_TOKENS, POTION_MODEL_ID, POTION_REVISION, type PotionRuntime } from "@turenlabs/plugin/potion"
import { Effect, Layer, LayerMap, Stream } from "effect"
import { testEffect } from "./lib/effect"

// The user's tree is the intended corpus; machines without it fall back to this repo.
const directory = AbsolutePath.make(
  existsSync("/Users/tom/turenos") ? "/Users/tom/turenos" : path.resolve(__dirname, "../../.."),
)

const model = Model.make({ id: "storm-model", provider: "fake", route: OpenAIChat.route })

let requestCount = 0

/** Last user-authored text in the request — marks whether the caller is a parent or a spawned worker. */
function lastUserText(request: LLMRequest) {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message.role !== "user") continue
    return message.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("")
  }
  return ""
}

const bashCommand = `for i in 1 2 3 4 5 6 7 8; do find "${directory}" -type f \\( -name "*.ts" -o -name "*.tsx" \\) | head -400 | xargs wc -l | tail -1; done`

const toolCallTurn = (id: string, name: string, input: Record<string, unknown>) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]
const textTurn = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

/** Most recent user-authored text containing `marker`, or undefined. */
function lastUserTextWith(request: LLMRequest, marker: string) {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message.role !== "user") continue
    const text = message.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("")
    if (text.includes(marker)) return text
  }
  return undefined
}

// Worker turns: bash, then code_search, then finish. Parent turns: one spawn
// batch per requested round, then text acknowledgements for advisory wakes.
// Settle advisories also arrive as user text, so classification keys on the
// newest ORCHESTRATE/WORKER marker rather than the newest user message.
function scriptFor(request: LLMRequest): LLMEvent[] {
  const text = lastUserText(request)
  const toolResults = request.messages.filter((message) => message.role === "tool").length
  if (text.includes("WORKER")) {
    if (toolResults === 0)
      return toolCallTurn(`call-bash-${requestCount}`, "bash", {
        command: bashCommand,
        workdir: ".",
        timeout: 120_000,
      })
    if (toolResults === 1)
      return toolCallTurn(`call-search-${requestCount}`, "code_search", {
        queries: ["session runner drain phases", "tool snapshot materialization"],
      })
    return textTurn(`text-worker-${requestCount}`, "worker done")
  }
  if (toolResults === 0 && text.includes("WARMUP")) {
    return toolCallTurn(`call-warm-${requestCount}`, "code_search", {
      queries: ["session runner drain phases"],
    })
  }
  const orchestrate = lastUserTextWith(request, "ORCHESTRATE")
  if (orchestrate !== undefined) {
    const round = /round (\d+)/.exec(orchestrate)?.[1] ?? "0"
    const spawned = request.messages.some(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message).includes("spawn_agents") &&
        JSON.stringify(message).includes(`r${round} `),
    )
    if (!spawned) {
      const parent = /parent (\w+)/.exec(orchestrate)?.[1] ?? "x"
      return toolCallTurn(`call-spawn-${requestCount}`, "spawn_agents", {
        items: [0, 1, 2].map((index) => ({
          agent: "worker",
          description: `worker ${index} r${round} p${parent}`,
          prompt: `WORKER round ${round} parent ${parent} index ${index}: run the find loop, then code_search, then report`,
        })),
        wave: `r${round}`,
      })
    }
  }
  return textTurn(`text-parent-${requestCount}`, "acknowledged")
}

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requestCount += 1
      return Stream.fromIterable(scriptFor(request))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed({
    model,
    ref: ModelV2.Ref.make({
      id: ModelV2.ID.make(model.id),
      providerID: ProviderV2.ID.make(model.provider),
    }),
    cost: [],
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: () => Effect.die("unused"),
    assert: () => Effect.void,
    reply: () => Effect.die("unused"),
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const workers = [
  AgentV2.Info.empty(AgentV2.ID.make("build")),
  { ...AgentV2.Info.empty(AgentV2.ID.make("worker")), mode: "subagent" as const },
]
const agents = Layer.succeed(
  AgentV2.Service,
  AgentV2.Service.of({
    get: (id) => Effect.succeed(workers.find((agent) => agent.id === id)),
    all: () => Effect.succeed([...workers]),
    default: () => Effect.succeed(workers[0]),
    select: (id) =>
      Effect.succeed({
        id: AgentV2.ID.make(id ?? "build"),
        info: workers.find((agent) => agent.id === id) ?? workers[0],
      }),
    resolve: (id) => Effect.succeed(workers.find((agent) => agent.id === id) ?? workers[0]),
    // Transforms mutate the agent set; this stub has a fixed set, so a
    // transform registers then immediately becomes removable.
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
  }),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
  }),
)

// Same broker-backed MCP stub as session-runner.test.ts: no capabilities listed,
// but tool_search/tool_load broker state stays real.
const mcpSource = Layer.succeed(
  McpTool.Source,
  McpTool.Source.of({
    list: () => Effect.succeed([]),
    begin: (input) =>
      Effect.sync(() => ToolBroker.beginTurn(input.sessionID, input.capabilities, input.directory)),
    selected: (input) =>
      Effect.sync(() =>
        ToolBroker.selected(input.sessionID, input.capabilities, input.directory).map(
          (capability) => capability.key,
        ),
      ),
    search: (input) =>
      Effect.sync(() => ToolBroker.search(input.sessionID, input.capabilities, input.query, input.directory)),
    load: (input) =>
      Effect.try({
        try: () => ToolBroker.load(input.sessionID, input.capabilities, input.tools, input.directory),
        catch: (error) => new Tool.Failure({ message: error instanceof Error ? error.message : String(error) }),
      }),
    touch: (input) => Effect.sync(() => ToolBroker.touch(input.sessionID, input.key, input.directory)),
  }),
)

// A >16-text embed call is the whole-vocabulary pass; smaller batches are query
// expansion — the split shows how often searches pay a full-vocab re-embed.
const potionCalls = { vocab: 0, query: 0 }
const fakePotion: PotionRuntime = {
  profile: {
    model: POTION_MODEL_ID,
    revision: POTION_REVISION,
    dimension: 8,
    dimensions: 8,
    maxTokens: POTION_MAX_TOKENS,
  },
  embed(texts) {
    if (texts.length > 16) potionCalls.vocab += 1
    else potionCalls.query += 1
    return texts.map((text) => {
      const vec = new Float32Array(8)
      for (let i = 0; i < text.length; i++) vec[i % 8] = (vec[i % 8] + (text.charCodeAt(i) % 251)) % 97
      return vec
    })
  },
  close() {},
}

const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})

const runnerLayer = AppNodeBuilder.build(
  LayerNode.group([
    SessionRunnerLLM.node,
    SessionTodo.node,
    SessionHarness.node,
    BashTool.node,
    CodeSearchTool.node,
  ]),
  [
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [Location.node, Location.boundNode({ directory })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [AgentV2.node, agents],
    [Config.node, config],
    [McpTool.sourceNode, mcpSource],
    [Snapshot.node, Snapshot.noopLayer],
    [CodeSearch.node, CodeSearch.nodeWith(() => Promise.resolve(fakePotion))],
  ],
)

// Production session execution: drains resolve their Location through the map,
// which is what settles tasks, publishes settle advisories, and releases
// coordinator state — the pieces a hand-rolled coordinator would drop.
const execution = SessionExecutionLocal.node

// Same 60-minute idle TTL as production buildLocationServiceMap — the default
// zero TTL would rebuild the whole Location graph (fresh CodeSearch index,
// fresh tool registry) every time a drain releases it.
const executionLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => runnerLayer as unknown as Layer.Layer<LocationServices>, {
    idleTimeToLive: "60 minutes",
  }),
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
      Reflection.node,
      SessionRunnerModel.node,
      SessionHarness.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      SessionRunnerLLM.node,
      SessionExecutionLocal.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [AgentV2.node, agents],
      [SessionRunnerModel.node, models],
      [Location.node, Location.boundNode({ directory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [SessionExecution.node, execution],
      [LocationServiceMap.node, executionLocations],
      [Config.node, config],
      [McpTool.sourceNode, mcpSource],
      [Snapshot.node, Snapshot.noopLayer],
    ],
  ),
)

const parentIDs = ["ses_storm_a", "ses_storm_b", "ses_storm_c"].map((id) => SessionV2.ID.make(id))

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of [...parentIDs, SessionV2.ID.make("ses_storm_warm")]) {
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory, title: id, version: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

const terminalTaskStatuses = ["completed", "failed", "cancelled", "interrupted"] as const

/** All spawned tasks terminal and no drain active anywhere. */
const settled = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const execution = yield* SessionExecution.Service
  const pending = yield* db
    .select({ id: SessionTaskTable.id })
    .from(SessionTaskTable)
    .where(notInArray(SessionTaskTable.status, [...terminalTaskStatuses]))
    .all()
    .pipe(Effect.orDie)
  const active = yield* execution.active
  return pending.length === 0 && active.size === 0 ? (true as const) : undefined
})

const untilSettled = (round: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const execution = yield* SessionExecution.Service
    const deadline = Date.now() + 300_000
    let lastLog = 0
    while (Date.now() < deadline) {
      if (yield* settled) return
      if (Date.now() - lastLog > 15_000) {
        lastLog = Date.now()
        const active = yield* execution.active
        console.log(`  waiting: requests=${requestCount} vocab=${potionCalls.vocab} active=${active.size}`)
        for (const sessionID of active) {
          const last = yield* db
            .select({ type: SessionMessageTable.type, data: SessionMessageTable.data })
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, sessionID))
            .orderBy(SessionMessageTable.seq)
            .all()
            .pipe(Effect.orDie)
          const tail = last.at(-1)
          const tool = tail
            ? JSON.stringify(tail.data)
                .match(/"name":"(\w+)","[^"]*":{"[^}]*"status":"(\w+)"/)
            : undefined
          console.log(`    ${sessionID.slice(-8)}: last=${tail?.type} tool=${tool?.[1] ?? "-"}:${tool?.[2] ?? "-"}`)
        }
      }
      yield* Effect.sleep("500 millis")
    }
    const rows = yield* db.select().from(SessionTaskTable).all().pipe(Effect.orDie)
    const active = yield* execution.active
    console.log(
      "stuck tasks:",
      JSON.stringify(rows.map((row) => ({ id: row.id, status: row.status, error: row.error }))),
      "active:",
      JSON.stringify([...active]),
    )
    for (const sessionID of active) {
      const messages = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      console.log(
        `session ${sessionID}: ${messages.length} msgs`,
        JSON.stringify(
          messages.slice(-3).map((message) => ({
            seq: message.seq,
            type: message.type,
            data: JSON.stringify(message.data).slice(0, 900),
          })),
        ),
      )
    }
    yield* Effect.die(new Error(`round ${round} never settled`))
  })

const sample = () => {
  fullGC()
  fullGC()
  const stats = heapStats()
  // Native/external allocations (buffers, sqlite, embedder tensors) land in
  // extraMemorySize, not heapSize — a leak there never shows in object counts.
  return {
    heap: stats.heapSize,
    extra: stats.extraMemorySize,
    counts: stats.objectTypeCounts,
  }
}

const ROUNDS = 6

describe("subagent storm heap probe", () => {
  it.live(
    "three parents spawn workers running bash and code_search, heap stays bounded",
    () =>
      Effect.gen(function* () {
        yield* seed
        const session = yield* SessionV2.Service
        const executionService = yield* SessionExecution.Service
        // Cold-start index build over a large tree parks every concurrent
        // searcher on one shared promise; warm it with a real drain up front so
        // the storm measures steady-state behavior, not first-query cost.
        console.log("warming code_search index")
        yield* session.prompt({
          sessionID: SessionV2.ID.make("ses_storm_warm"),
          prompt: Prompt.make({ text: "WARMUP index build" }),
          resume: false,
        })
        yield* executionService.wake(SessionV2.ID.make("ses_storm_warm"))
        yield* untilSettled(-1)
        console.log(`index warmed, requests: ${requestCount}`)
        const rounds: Array<ReturnType<typeof sample>> = []
        for (let round = 0; round < ROUNDS; round += 1) {
          console.log(`round ${round}: prompting`)
          for (const sessionID of parentIDs) {
            yield* session.prompt({
              sessionID,
              prompt: Prompt.make({ text: `ORCHESTRATE round ${round} parent ${sessionID.slice(-1)}` }),
              resume: false,
            })
          }
          for (const sessionID of parentIDs) {
            yield* executionService.wake(sessionID)
          }
          yield* untilSettled(round)
          console.log(`round ${round}: settled, requests: ${requestCount}`)
          rounds.push(sample())
          console.log(
            `round ${round}: heap=${(rounds[round].heap / 1048576).toFixed(1)}MB requests=${requestCount} vocab=${potionCalls.vocab}`,
          )
        }
        // After warm-up the heap should plateau; unbounded per-round growth is
        // the per-spawn retention failure.
        const last = rounds.at(-1)!
        const baseline = rounds[0]
        const deltas = Object.entries(last.counts)
          .map(([type, count]) => ({ type, count, delta: count - (baseline.counts[type] ?? 0) }))
          .sort((a, b) => b.delta - a.delta)
          .slice(0, 12)
        console.log(
          `heap growth round0→${ROUNDS - 1}: ${((last.heap - baseline.heap) / 1048576).toFixed(1)}MB extra ${(
            (last.extra - baseline.extra) /
            1048576
          ).toFixed(1)}MB`,
        )
        console.log("top retained object types:", JSON.stringify(deltas))
        const { db } = yield* Database.Service
        const tasks = yield* db.select().from(SessionTaskTable).all().pipe(Effect.orDie)
        const byStatus = new Map<string, number>()
        for (const row of tasks) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1)
        console.log(
          `task rows: ${tasks.length} (${[...byStatus].map(([s, n]) => `${s}:${n}`).join(" ")})`,
        )
        // 3 parents × 3 workers × 6 rounds = 54 child tasks, all terminal.
        expect(tasks.length).toBe(54)
        const terminal: ReadonlyArray<string> = terminalTaskStatuses
        expect(tasks.every((row) => terminal.includes(row.status))).toBe(true)
        expect(last.heap).toBeLessThan(baseline.heap * 3 + 64 * 1048576)
        expect(last.extra).toBeLessThan(baseline.extra * 3 + 128 * 1048576)
      }),
    900_000,
  )
})
