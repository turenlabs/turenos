// Reproduces the 1.0.34 all-tabs-refresh regression: concurrent subagent +
// shell drains produce an event burst that filled the SSE subscriber bound
// (256) faster than a busy renderer could drain it. The stream failed, the
// client reconnected, and `server.connected` re-bootstrapped every tab.
// The subscriber bound is now the EventV2 pubsub bound (8192); a stalled
// reader must absorb a realistic burst without the stream dying.

import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { EventV2 } from "@turenlabs/core/event"
import { Watcher } from "@turenlabs/core/filesystem/watcher"
import { CodeSearch } from "@turenlabs/core/search"
import { Reflection } from "@turenlabs/core/reflection"
import { SessionStore } from "@turenlabs/core/session/store"
import { Pty } from "@turenlabs/schema/pty"
import { AbsolutePath } from "@turenlabs/schema/schema"
import { ConfigV1 } from "@turenlabs/core/v1/config/config"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import { POTION_MAX_TOKENS, POTION_MODEL_ID, POTION_REVISION, type PotionRuntime } from "@turenlabs/plugin/potion"
import { EventSequenceTable, EventTable } from "@turenlabs/core/event/sql"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Shell } from "@turenlabs/core/shell"
import { FSUtil } from "@turenlabs/core/fs-util"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import { Session } from "../../src/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MCP } from "../../src/mcp"
import { LSP } from "../../src/lsp/lsp"
import { GlobalBus } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { reply, TestLLMServer } from "../lib/llm-server"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"
import { encodeEvents } from "../../src/server/routes/instance/httpapi/handlers/global"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

// Deterministic embedder with call counters — vocab rebuilds arrive as one
// large batch while query expansion embeds a few terms at a time, so the split
// proves how often searches pay a full-vocab re-embed under file churn.
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
      for (let i = 0; i < text.length; i++) vec[i % 8] = (vec[i % 8]! + (text.charCodeAt(i) % 251)) % 97
      return vec
    })
  },
  close() {},
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    log: () => Effect.succeed([]),
    configuration: () => Effect.succeed(undefined),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () =>
      Effect.succeed({ status: { status: "disabled" as const }, candidate: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    reset: () => Effect.void,
    runBackground: (_name, effect) => effect,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in workload tests"),
    authenticate: () => Effect.die("unexpected MCP auth in workload tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in workload tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const testLLMServerNode = LayerNode.make({
  service: TestLLMServer,
  layer: TestLLMServer.layer.pipe(Layer.orDie),
  deps: [],
})

const providerNode = LayerNode.make({
  service: Provider.Service,
  layer: Layer.effect(
    Provider.Service,
    Effect.gen(function* () {
      return ProviderTest.openAICompatible((yield* TestLLMServer).url).service
    }),
  ).pipe(Layer.orDie),
  deps: [testLLMServerNode],
})

// Mirror of prompt.test.ts's promptRoot — the full drain graph. Dropping
// nodes here lets transitive deps resolve through ambient discovery (real
// provider auth), which passes on dev machines and dies in CI with
// ProviderNoProvidersError.
const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  ExtensionRuntime.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  McpTool.sourceNode,
  EventV2.node,
  Reflection.node,
  SessionStore.node,
  // Unbound on its own; listing it here lets AppNodeBuilder bind the
  // per-location map (including the CodeSearch replacement below).
  LocationServiceMap.node,
  testLLMServerNode,
])

const stack = Layer.mergeAll(
  httpApiLayer,
  AppNodeBuilder.build(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [Provider.node, providerNode],
    [CodeSearch.node, CodeSearch.nodeWith(() => Promise.resolve(fakePotion))],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

// Isolated build: the SSE route observes GlobalBus, which is a module
// singleton — no shared memoMap needed. Isolation keeps the fake Provider
// pinned even when other files in the shard build shared graphs first.
const it = testEffect(stack)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const EventData = Schema.Struct({
  directory: Schema.optional(Schema.String),
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.String,
    properties: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    data: Schema.optional(Schema.Any),
  }),
})

// SSE frames are `data: {...}\n\n`; socket chunks can split a frame anywhere,
// so accumulate bytes and only decode frames that have terminated.
function frameParser() {
  const decoder = new TextDecoder()
  let buffer = ""
  const all: { type: string; id?: string; directory?: string; properties?: Record<string, unknown> }[] = []
  return {
    all,
    feed(parts: Iterable<Uint8Array>) {
      for (const part of parts) buffer += decoder.decode(part, { stream: true })
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      const events = frames
        .map((frame) => {
          // Frames may carry `id:`/`event:` lines before the data payload.
          const line = frame.split("\n").find((l) => l.startsWith("data: "))
          if (!line) return undefined
          const envelope = Schema.decodeUnknownSync(EventData)(JSON.parse(line.slice(6)))
          return { ...envelope.payload, directory: envelope.directory }
        })
        .filter((event) => event !== undefined)
      all.push(...events)
      return events
    },
  }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

const marker = (value: string) => (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes(value)

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = Date.now()
    const result = yield* effect
    return [result, Date.now() - started] as const
  })

describe("event stream under agent workload", () => {
  it.live(
    "concurrent subagent + shell drains do not drop the global event stream",
    () =>
      provideTmpdirServer(({ dir, llm }) =>
        Effect.gen(function* () {
          const response = yield* request(GlobalPaths.event)
          expect(response.status).toBe(200)

          // A busy renderer stops pulling the socket: gate each element so the
          // reader can stall mid-stream, giving the server-side subscriber queue
          // real backpressure — the pre-fix failure mode.
          const opened = Deferred.makeUnsafe<void>()
          yield* Deferred.succeed(opened, undefined)
          const gate = yield* Ref.make(opened)
          const chunks = yield* Queue.unbounded<Uint8Array>()
          const streamExit = yield* Deferred.make<Exit.Exit<void, unknown>>()
          yield* response.stream.pipe(
            Stream.mapEffect((value) => Ref.get(gate).pipe(Effect.flatMap(Deferred.await), Effect.as(value))),
            Stream.runForEach((value) => Queue.offer(chunks, value)),
            Effect.exit,
            Effect.flatMap((exit) => Deferred.succeed(streamExit, exit)),
            Effect.forkScoped,
          )

          const parser = frameParser()
          const drain = () =>
            Effect.gen(function* () {
              const part = yield* Queue.take(chunks).pipe(
                Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(undefined) }),
              )
              return parser.feed(part === undefined ? yield* Queue.takeAll(chunks) : [part])
            })
          const until = (
            check: (event: { type: string }) => boolean,
            message: string,
            duration: Duration.Input = "30 seconds",
          ) =>
            pollWithTimeout(
              drain().pipe(Effect.map((events) => (events.some(check) ? (true as const) : undefined))),
              message,
              duration,
            )

          yield* until((event) => event.type === "server.connected", "global event stream never delivered server.connected")

          // Stall the reader for the whole workload window.
          const paused = Deferred.makeUnsafe<void>()
          yield* Ref.set(gate, paused)

          // Persona: two sessions on one project. Each cycles shell calls;
          // alpha fires subagent tasks mid-drain — the event shape of a heavy
          // multi-agent session. `task` runs each child drain in the
          // background and injects the result back into the parent.
          const alphaTurns = 8
          const betaTurns = 8
          const children = 3
          const bash = (command: string) => reply().tool("bash", { command })
          const task = (index: number) =>
            reply().tool("task", {
              description: `swarm child ${index}`,
              prompt: `swarm-child-${index}: run one shell command then report back`,
              subagent_type: "explore",
            })
          for (let i = 0; i < alphaTurns; i++) {
            yield* llm.pushMatch(marker("workload-alpha"), bash(`echo alpha-${i}`))
            if (i === 2) for (let c = 0; c < children; c++) yield* llm.pushMatch(marker("workload-alpha"), task(c))
          }
          // A few trailing turns absorb the result-injection drains that fire
          // when children settle.
          for (let i = 0; i < children + 1; i++) {
            yield* llm.pushMatch(marker("workload-alpha"), reply().text(`alpha followup ${i}`).stop())
          }
          for (let i = 0; i < betaTurns; i++) {
            yield* llm.pushMatch(marker("workload-beta"), bash(`echo beta-${i}`))
          }
          yield* llm.pushMatch(marker("workload-beta"), reply().text("beta finished").stop())
          for (let i = 0; i < children; i++) {
            yield* llm.pushMatch(marker(`swarm-child-${i}`), bash(`echo child-${i}`))
            yield* llm.pushMatch(marker(`swarm-child-${i}`), reply().text(`child-${i} report`).stop())
          }

          const result = yield* withSh(() =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const permission = [{ permission: "*", pattern: "*", action: "allow" as const }]
              const alpha = yield* sessions.create({ title: "alpha", permission })
              const beta = yield* sessions.create({ title: "beta", permission })
              yield* prompt.prompt({
                sessionID: alpha.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "workload-alpha: run the queued shell commands" }],
              })
              yield* prompt.prompt({
                sessionID: beta.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "workload-beta: run the queued shell commands" }],
              })

              yield* Effect.all(
                [
                  prompt.loop({ sessionID: alpha.id }),
                  prompt.loop({ sessionID: beta.id }),
                ],
                { concurrency: "unbounded" },
              )
              return [alpha.id, beta.id]
            }),
          )
          expect(result).toHaveLength(2)

          // While the reader is still stalled, pad the stream: large events fill
          // TCP buffers quickly, pushing backlog into the subscriber queue. The
          // workload's own events plus this burst exceed the old 256 bound; the
          // 8192 bound absorbs it.
          const flood = 1500
          for (let i = 0; i < flood; i++) {
            GlobalBus.emit("event", {
              directory: "probe",
              payload: { type: "workload.flood", properties: { i, pad: "x".repeat(2048) } },
            })
          }

          // Resume the reader and wait for the mock to go quiet — children may
          // still be settling after the parent drains return.
          yield* Deferred.succeed(paused, undefined)
          yield* awaitWithTimeout(
            Effect.gen(function* () {
              let last = -1
              while (true) {
                const calls = yield* llm.calls
                if (calls === last) return
                last = calls
                yield* Effect.sleep("800 millis")
              }
            }),
            "mock LLM traffic never went quiet",
            "60 seconds",
          )
          yield* Effect.sleep("500 millis")

          const events = [...parser.all, ...parser.feed(yield* Queue.takeAll(chunks))]

          // The burst must exceed the old 256-event subscriber bound — that is
          // what made this a regression test rather than a smoke test.
          expect(events.length).toBeGreaterThan(256)
          expect(events.filter((event) => event.type === "server.connected")).toHaveLength(1)
          expect(events.some((event) => event.type === "message.part.updated")).toBe(true)
          expect(events.filter((event) => event.type === "workload.flood")).toHaveLength(flood)

          // Workload events are scoped to the instance directory — nothing
          // leaks across project boundaries on the global stream.
          const scoped = events.filter(
            (event) => event.directory !== undefined && event.directory !== "probe" && event.directory !== "global",
          )
          expect(scoped.length).toBeGreaterThan(0)
          expect(scoped.every((event) => event.directory === dir)).toBe(true)

          // The stream is still open — no overflow drop, no forced resync.
          expect(yield* Deferred.poll(streamExit)).toEqual(Option.none())
          GlobalBus.emit("event", {
            directory: "probe",
            payload: { type: "workload.probe", properties: {} },
          })
          yield* until(
            (event) => event.type === "workload.probe",
            "post-workload probe never arrived — event stream died under workload",
            "10 seconds",
          )
        }),
        { config: { formatter: false, lsp: false } },
      ),
    120_000,
  )

  const emit = (type: string, i: number) =>
    GlobalBus.emit("event", { directory: "probe", payload: { type, properties: { i } } })

  // An SSE subscriber opened against the test server with a parsed frame
  // stream. `until` resolves once a matching frame has been parsed.
  const subscriber = Effect.fnUntraced(function* (init?: RequestInit) {
    const response = yield* request(GlobalPaths.event, init)
    expect(response.status).toBe(200)
    const chunks = yield* Queue.unbounded<Uint8Array>()
    const reader = yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(chunks, value)),
      Effect.forkScoped,
    )
    const parser = frameParser()
    const until = (check: (event: (typeof parser.all)[number]) => boolean, message: string) =>
      pollWithTimeout(
        Effect.gen(function* () {
          const part = yield* Queue.take(chunks).pipe(
            Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(undefined) }),
          )
          parser.feed(part === undefined ? yield* Queue.takeAll(chunks) : [part])
          return parser.all.some(check) ? (true as const) : undefined
        }),
        message,
        "15 seconds",
      )
    return { parser, reader, until }
  })

  it.live("reconnecting with Last-Event-ID replays missed events instead of resyncing", () =>
    Effect.gen(function* () {
      const first = yield* subscriber()
      yield* first.until(
        (event) => event.type === "server.connected" && event.properties?.resume === "initial",
        "first connect never delivered server.connected resume=initial",
      )

      emit("replay.before", 1)
      emit("replay.before", 2)
      yield* first.until(
        (event) => event.type === "replay.before" && event.properties?.i === 2,
        "cursor event never arrived",
      )
      const cursor = first.parser.all.findLast((event) => event.type === "replay.before")?.id
      expect(cursor).toBeDefined()
      yield* Fiber.interrupt(first.reader)

      // Events emitted while the subscriber is gone.
      emit("replay.during", 1)
      emit("replay.during", 2)

      const second = yield* subscriber({ headers: { "Last-Event-ID": String(cursor) } })
      yield* second.until(
        (event) => event.type === "replay.during" && event.properties?.i === 2,
        "missed events were not replayed after resume",
      )

      const connected = second.parser.all[0]
      expect(connected?.type).toBe("server.connected")
      expect(connected?.properties?.resume).toBe("ok")
      // The replay covers the gap exactly: nothing older than the cursor
      // repeats, and both missed events arrived in order before live ones.
      const replayed = second.parser.all.filter((event) => event.type === "replay.during")
      expect(replayed.map((event) => event.properties?.i)).toEqual([1, 2])
      expect(second.parser.all.some((event) => event.type === "replay.before")).toBe(false)

      emit("replay.after", 1)
      yield* second.until(
        (event) => event.type === "replay.after",
        "live events stopped after backlog replay",
      )

      // A cursor the server can no longer place asks the client to resync.
      const stale = yield* subscriber({ headers: { "Last-Event-ID": "evt_stale000000000000000000000" } })
      yield* stale.until(
        (event) => event.type === "server.connected",
        "stale cursor never delivered server.connected",
      )
      expect(stale.parser.all[0]?.properties?.resume).toBe("gap")
    }),
    60_000,
  )

  // The 1.0.36 wedge: under burst load the handler ran JSON.stringify once per
  // event per subscriber, so each attached stream multiplied serialization
  // cost on the main thread. The frame is rendered once per event and shared.
  it.live("serializes each event once across subscribers", () =>
    Effect.gen(function* () {
      const first = yield* subscriber()
      const second = yield* subscriber()
      yield* first.until((event) => event.type === "server.connected", "first subscriber never connected")
      yield* second.until((event) => event.type === "server.connected", "second subscriber never connected")

      let serializations = 0
      GlobalBus.emit("event", {
        directory: "probe",
        payload: {
          type: "serialize.once",
          properties: {
            get marker() {
              serializations++
              return "probe"
            },
          },
        },
      })

      yield* first.until((event) => event.type === "serialize.once", "first subscriber missed the event")
      yield* second.until((event) => event.type === "serialize.once", "second subscriber missed the event")
      expect(serializations).toBe(1)
    }),
    60_000,
  )

  // The other half of the 1.0.36 wedge: the response stream issued one socket
  // write per event, so a burst multiplied WriteString calls across every
  // attached subscriber and starved the loop. encodeEvents groups bursts into
  // bounded writes — each element it emits is one write — without dropping or
  // reordering frames.
  test("encodeEvents joins an event burst into bounded socket writes", async () => {
    const flood = 1000
    const events = Array.from({ length: flood }, (_, i) => ({
      directory: "probe",
      payload: { id: `evt_probe${i}`, type: "workload.flood", properties: { i } },
    }))
    const writes = await Effect.runPromise(
      encodeEvents(Stream.fromIterable(events)).pipe(Stream.runCollect),
    )
    expect(writes.length).toBeLessThanOrEqual(Math.ceil(flood / 256))
    const text = Array.from(writes, (write) => new TextDecoder().decode(write)).join("")
    const frames = text.split("\n\n").filter((frame) => frame.length > 0)
    expect(frames).toHaveLength(flood)
    const parser = frameParser()
    const parsed = parser.feed(writes)
    expect(parsed.map((event) => event.properties?.i)).toEqual(Array.from({ length: flood }, (_, i) => i))
  })

  // Storm scale: every subscriber must receive the whole burst in order, and a
  // connection that drops mid-life must resume by replay — the wedge made
  // reconnects trigger a full resync that flashed every tab.
  it.live("subscribers that drop mid-storm resume by replay instead of resyncing", () =>
    Effect.gen(function* () {
      const subscribers = 6
      const flood = 4000
      const subs = yield* Effect.forEach(
        Array.from({ length: subscribers }),
        () => subscriber(),
        { concurrency: "unbounded" },
      )
      yield* Effect.all(
        subs.map((sub, i) =>
          sub.until((event) => event.type === "server.connected", `subscriber ${i} never connected`),
        ),
        { concurrency: "unbounded" },
      )

      for (let i = 0; i < flood; i++) emit("workload.flood", i)

      const dropped = subs[0]
      yield* Effect.all(
        subs.map((sub, i) =>
          sub.until(
            (event) => event.type === "workload.flood" && event.properties?.i === flood - 1,
            `subscriber ${i} missed the storm tail`,
          ),
        ),
        { concurrency: "unbounded" },
      )

      // A subscriber drops after the storm; traffic continues while it is gone.
      yield* Fiber.interrupt(dropped.reader)
      emit("workload.during", 1)
      emit("workload.during", 2)

      const cursor = dropped.parser.all.findLast((event) => event.type === "workload.flood")?.id
      expect(cursor).toBeDefined()
      const rejoined = yield* subscriber({ headers: { "Last-Event-ID": String(cursor) } })
      yield* rejoined.until(
        (event) => event.type === "workload.during" && event.properties?.i === 2,
        "missed events were not replayed for the rejoined subscriber",
      )
      expect(rejoined.parser.all[0]?.properties?.resume).toBe("ok")
      expect(rejoined.parser.all.filter((event) => event.type === "workload.during").map((event) => event.properties?.i)).toEqual(
        [1, 2],
      )
      expect(rejoined.parser.all.some((event) => event.type === "workload.flood")).toBe(false)
    }),
    120_000,
  )

  // The wedge ran against a 6.3GB database: ~1k sessions, ~46k session_message
  // rows, ~430k durable events — skewed, with a few sessions carrying hundreds
  // of messages. Seed that shape synthetically (scaled for CI; raise the env
  // knobs to probe a heavier rig) and prove the hot reads stay bounded while an
  // SSE storm is in flight.
  it.live("session and event reads stay bounded over a large seeded database", () =>
    provideTmpdirServer(({ dir }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service

        // Clone a real session row so project/directory/version stay honest.
        const probe = yield* sessions.create({ title: "seed probe" })
        const template = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, probe.id))
          .get()
          .pipe(Effect.orDie)
        if (!template) return yield* Effect.die("seed probe session row missing")

        const sessionCount = Number(process.env.BULK_SESSIONS ?? 600)
        const heavy = Math.min(12, sessionCount)
        const heavyMessages = Number(process.env.BULK_HEAVY_MESSAGES ?? 800)
        const lightMessages = 24
        const eventsPerHeavy = Number(process.env.BULK_HEAVY_EVENTS ?? 8_000)
        const eventsPerLight = 60
        const base = Date.now() - 30 * 86_400_000

        const seeded: (typeof probe.id)[] = []
        for (let i = 0; i < sessionCount; i += 200) {
          yield* db
            .insert(SessionTable)
            .values(
              Array.from({ length: Math.min(200, sessionCount - i) }, (_, j) => {
                const index = i + j
                const id = SessionSchema.ID.make(`ses_bulk_${String(index).padStart(6, "0")}`)
                seeded.push(id)
                return {
                  ...template,
                  id,
                  slug: `bulk-${index}`,
                  title: `bulk session ${index}`,
                  parent_id: null,
                  time_created: base + index * 60_000,
                  time_updated: base + index * 60_000,
                }
              }),
            )
            .run()
            .pipe(Effect.orDie)
        }

        type MessageInsert = typeof SessionMessageTable.$inferInsert
        const messageRows: MessageInsert[] = []
        for (const [index, sessionID] of seeded.entries()) {
          const count = index < heavy ? heavyMessages : lightMessages
          for (let seq = 1; seq <= count; seq++) {
            const assistant = seq % 2 === 0
            const created = base + index * 60_000 + seq
            // Wire-shaped JSON; the column is schemaless text at rest.
            const data: Record<string, unknown> = assistant
              ? {
                  time: { created, completed: created + 500 },
                  agent: "build",
                  model: { id: "gpt-5.6-luna", providerID: "openai" },
                  content: [{ type: "text", id: `txt_${index}_${seq}`, text: `assistant reply ${seq}` }],
                }
              : {
                  time: { created },
                  text: `bulk user message ${seq}`,
                  parts: [{ id: `part_${index}_${seq}`, type: "text", text: `bulk user message ${seq}` }],
                }
            messageRows.push({
              id: `msg_bulk_${index}_${seq}` as MessageInsert["id"],
              session_id: sessionID,
              type: assistant ? "assistant" : "user",
              seq,
              time_created: created,
              time_updated: created,
              data: data as MessageInsert["data"],
            })
          }
        }
        for (let i = 0; i < messageRows.length; i += 300) {
          yield* db
            .insert(SessionMessageTable)
            .values(messageRows.slice(i, i + 300))
            .run()
            .pipe(Effect.orDie)
        }

        // Durable events: the real table's biggest read surface. Aggregates
        // follow sessions; heavy sessions carry most of the volume.
        const eventTypes = [
          "session.next.tool.input.started.1",
          "session.next.tool.input.ended.1",
          "session.next.tool.called.1",
          "session.next.tool.success.1",
          "session.next.step.started.1",
          "session.next.step.ended.2",
          "session.next.reasoning.started.1",
          "session.next.reasoning.ended.1",
        ]
        const sequenceRows = seeded.map((aggregateID, index) => ({
          aggregate_id: aggregateID,
          seq: index < heavy ? eventsPerHeavy : eventsPerLight,
          owner_id: null,
        }))
        for (let i = 0; i < sequenceRows.length; i += 300) {
          yield* db
            .insert(EventSequenceTable)
            .values(sequenceRows.slice(i, i + 300))
            .run()
            .pipe(Effect.orDie)
        }
        const eventRows: (typeof EventTable.$inferInsert)[] = []
        for (const [index, aggregateID] of seeded.entries()) {
          const count = index < heavy ? eventsPerHeavy : eventsPerLight
          for (let seq = 1; seq <= count; seq++) {
            eventRows.push({
              id: `evt_bulk_${index}_${seq}` as EventV2.ID,
              aggregate_id: aggregateID,
              seq,
              type: eventTypes[seq % eventTypes.length],
              data: {
                timestamp: base + seq,
                sessionID: aggregateID,
                assistantMessageID: `msg_bulk_${index}_${Math.ceil(seq / 12)}`,
                callID: `call_${index}_${seq}`,
                tool: "bash",
                input: { command: `echo ${seq}` },
                output: { text: "x".repeat(512) },
              },
            })
          }
        }
        for (let i = 0; i < eventRows.length; i += 300) {
          yield* db
            .insert(EventTable)
            .values(eventRows.slice(i, i + 300))
            .run()
            .pipe(Effect.orDie)
        }

        // Prove the fixture is the claimed volume — a seed that silently
        // short-changes makes the probes below meaningless.
        const counts = yield* db
          .all<{ events: number; messages: number; sessions: number }>(sql`select
            (select count(*) from ${EventTable}) as events,
            (select count(*) from ${SessionMessageTable}) as messages,
            (select count(*) from ${SessionTable}) as sessions`)
          .pipe(Effect.orDie)
        const volumes = counts[0]
        // Ambient rows (the probe session's own event) make these floors.
        expect(volumes?.sessions).toBeGreaterThanOrEqual(sessionCount + 1)
        expect(volumes?.messages).toBeGreaterThanOrEqual(
          heavy * heavyMessages + (sessionCount - heavy) * lightMessages,
        )
        expect(volumes?.events).toBeGreaterThanOrEqual(
          heavy * eventsPerHeavy + (sessionCount - heavy) * eventsPerLight,
        )

        // Subscribers attached like open tabs, then a paced storm so the writes
        // overlap the reads below instead of draining before them.
        const subs = yield* Effect.forEach(
          Array.from({ length: 3 }),
          () => subscriber(),
          { concurrency: "unbounded" },
        )
        yield* Effect.all(
          subs.map((sub, i) =>
            sub.until((event) => event.type === "server.connected", `subscriber ${i} never connected`),
          ),
          { concurrency: "unbounded" },
        )

        const flood = 3000
        yield* Effect.gen(function* () {
          for (let i = 0; i < flood; i++) {
            GlobalBus.emit("event", {
              directory: "probe",
              payload: { type: "workload.flood", properties: { i, pad: "x".repeat(1024) } },
            })
            if (i % 64 === 0) yield* Effect.yieldNow
          }
        }).pipe(Effect.forkScoped)

        const [list, listMs] = yield* timed(requestInDirectory("/session", dir))
        expect(list.status).toBe(200)
        const listed = yield* list.json
        expect(Array.isArray(listed) && listed.length).toBeGreaterThan(0)

        // A history page mid-catch-up: exclude two aggregates at their last
        // seen seq, page the widest scan the API allows.
        const exclude = { [seeded[0]]: eventsPerHeavy - 100, [seeded[1]]: eventsPerHeavy - 50 }
        const [history, historyMs] = yield* timed(
          requestInDirectory("/sync/history?limit=10000", dir, { method: "POST", body: JSON.stringify(exclude) }),
        )
        expect(history.status).toBe(200)
        const page = yield* history.json
        expect(Array.isArray(page)).toBe(true)

        const [health, healthMs] = yield* timed(request(GlobalPaths.health))
        expect(health.status).toBe(200)

        yield* Effect.all(
          subs.map((sub, i) =>
            sub.until(
              (event) => event.type === "workload.flood" && event.properties?.i === flood - 1,
              `subscriber ${i} never drained the storm`,
            ),
          ),
          { concurrency: "unbounded" },
        )

        console.log("bulk probes", { listMs, historyMs, healthMs })
        // Wedges measured in minutes; these bounds only fail on real starvation.
        expect(listMs).toBeLessThan(15_000)
        expect(historyMs).toBeLessThan(15_000)
        expect(healthMs).toBeLessThan(5_000)
      }),
      { config: { formatter: false, lsp: false } },
    ),
    180_000,
  )

  // Every watcher event bumps the index version; an unguarded search would
  // re-embed the whole vocabulary on each query during churn. This test writes
  // real files, publishes watcher events between searches, and counts the fake
  // embedder's vocab batches — proving rebuild suppression inside the debounce
  // window and one refresh past it.
  it.live("code_search stays bounded while file churn invalidates the index", () =>
    provideTmpdirServer(({ dir }) =>
      Effect.gen(function* () {
        // CodeSearch is Location-scoped — resolve this directory's instance
        // through the location map, the same path the runtime uses.
        const locations = yield* LocationServiceMap.Service
        const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(dir) }))
        const search = yield* CodeSearch.Service.pipe(Effect.provide(locationLayer))
        const events = yield* EventV2.Service

        const files = 240
        // Family words group files so their terms land in the vocab df band
        // (df>=3, <=10% of files) — the band that feeds thesaurus embedding.
        const familyA = ["ember", "fable", "glen", "harbor", "ink", "jade", "keel", "loom", "mesa", "nook",
          "opal", "prism", "quill", "rune", "sable", "tide", "umber", "vale", "wisp", "yarn"]
        const familyB = ["anchor", "bloom", "cinder", "drift", "emberly", "forge", "grove", "haven", "islet",
          "jewel", "knoll"]
        const body = (i: number, round: number) =>
          `export function reconcileWatcher${i}Round${round}(dirtyFlush: string, coalesceMerge: number) {
  // ${familyA[i % 20]} ${familyB[i % 11]} reconcile watcher churn stale
  const churnWindow${i} = dirtyFlush + "stale window" + coalesceMerge
  return { path: "src/mod${i}", churnWindow${i}, reconcile: true, watcher: true }
}\n`
        yield* Effect.forEach(
          Array.from({ length: files }, (_, i) => i),
          (i) => Effect.promise(() => Bun.write(`${dir}/src/mod${i}.ts`, body(i, 0))),
          { concurrency: 16, discard: true },
        )

        const vocab0 = potionCalls.vocab
        const [firstHits, firstMs] = yield* timed(search.search({ queries: ["reconcile watcher"] }))
        expect(firstHits.length).toBeGreaterThan(0)
        // First call builds the index and embeds the vocabulary once.
        expect(firstMs).toBeLessThan(30_000)

        for (let round = 1; round <= 8; round++) {
          const touched = Array.from({ length: 8 }, (_, k) => (round * 8 + k) % files)
          yield* Effect.forEach(
            touched,
            (i) => Effect.promise(() => Bun.write(`${dir}/src/mod${i}.ts`, body(i, round))),
            { concurrency: 8, discard: true },
          )
          yield* Effect.forEach(
            touched,
            (i) =>
              events.publish(
                Watcher.Event.Updated,
                { file: `${dir}/src/mod${i}.ts`, event: "change" },
                { location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) },
              ),
            { discard: true },
          )
          const [hits, ms] = yield* timed(search.search({ queries: ["reconcile watcher churnWindow"] }))
          expect(hits.length).toBeGreaterThan(0)
          expect(ms).toBeLessThan(10_000)
        }
        // The churned searches all landed inside the debounce window — only the
        // initial build paid a vocabulary embed.
        expect(potionCalls.vocab - vocab0).toBe(1)

        // Past the window the stale table refreshes — bounded, not permanent.
        yield* Effect.sleep("2.5 seconds")
        const [afterHits] = yield* timed(search.search({ queries: ["reconcile watcher"] }))
        expect(afterHits.length).toBeGreaterThan(0)
        expect(potionCalls.vocab - vocab0).toBe(2)
      }),
      { config: { formatter: false, lsp: false } },
    ),
    120_000,
  )

  // The whole heavy persona in one storm: four sessions drain concurrently —
  // alpha spawns three subagents that run their own shells and file writes,
  // beta alternates write tool calls with a code_search (its writes churn the
  // index under test), gamma runs two drains while a separate leg drives the
  // reflection cadence machine (record → due → claim → complete) against its
  // live session, and delta's transcript is pruned after the storm.
  // Four SSE subscribers (open tabs) ride along, three PTY lifecycles run over
  // REST, and timed probes hit /session + /global/health mid-flight.
  it.live("silly busy persona: flying sessions, tabs, subagents, shells, writes, search", () =>
    provideTmpdirServer(({ dir, llm }) =>
      withSh(() =>
        Effect.gen(function* () {
          const tabs = yield* Effect.forEach(
            Array.from({ length: 4 }),
            () => subscriber(),
            { concurrency: "unbounded" },
          )
          yield* Effect.all(
            tabs.map((tab, i) => tab.until((event) => event.type === "server.connected", `tab ${i} never connected`)),
            { concurrency: "unbounded" },
          )

          // alpha: two shells, then one turn spawning all three subagents, then
          // settle absorbs child results. Trailing stops cover settle wakes.
          yield* llm.pushMatch(marker("workload-alpha"), reply().tool("bash", { command: "echo alpha-0" }))
          yield* llm.pushMatch(marker("workload-alpha"), reply().tool("bash", { command: "echo alpha-1" }))
          yield* llm.pushMatch(
            marker("workload-alpha"),
            reply()
              .tool("task", { description: "swarm 0", prompt: "swarm-child-0: shell then write", subagent_type: "explore" })
              .tool("task", { description: "swarm 1", prompt: "swarm-child-1: shell then write", subagent_type: "explore" })
              .tool("task", { description: "swarm 2", prompt: "swarm-child-2: shell then write", subagent_type: "explore" }),
          )
          for (let i = 0; i < 4; i++) {
            yield* llm.pushMatch(marker("workload-alpha"), reply().text(`alpha settle ${i}`).stop())
          }

          // children: one shell + one file write each — real churn under the
          // shared Location, so beta's code_search sees a dirty index.
          for (let c = 0; c < 3; c++) {
            yield* llm.pushMatch(marker(`swarm-child-${c}`), reply().tool("bash", { command: `echo child-${c}` }))
            yield* llm.pushMatch(
              marker(`swarm-child-${c}`),
              reply().tool("write", {
                path: `src/child-${c}.ts`,
                content: `export const childMarker${c} = "workload child ${c} reconcile watcher churn"\n`,
              }),
            )
            yield* llm.pushMatch(marker(`swarm-child-${c}`), reply().text(`child-${c} done`).stop())
          }

          // beta: writes + a code_search mid-drain, then stop.
          for (let i = 0; i < 3; i++) {
            yield* llm.pushMatch(
              marker("workload-beta"),
              reply().tool("write", {
                path: `src/beta-${i}.ts`,
                content: `export function betaWrite${i}() { return "beta reconcile watcher churn ${i}" }\n`,
              }),
            )
          }
          yield* llm.pushMatch(marker("workload-beta"), reply().tool("code_search", { queries: ["reconcile watcher churn"] }))
          yield* llm.pushMatch(marker("workload-beta"), reply().text("beta done").stop())

          // gamma: two sequential drains (bash + stop each). The reflection leg
          // drives the cadence machine on gamma's session concurrently.
          yield* llm.pushMatch(marker("workload-gamma"), reply().tool("bash", { command: "seq 1 4000" }))
          yield* llm.pushMatch(marker("workload-gamma"), reply().text("gamma pass one done").stop())
          yield* llm.pushMatch(marker("workload-gamma"), reply().text("gamma pass two done").stop())

          // delta: drain one runs fat-output bashes (each stored tool part is
          // truncation-bounded ~50KB ≈ 12k tokens, so several are needed to
          // clear the 40k-token protect window + 20k prune minimum); drains two
          // and three are cheap — prune only scans parts older than the last
          // two user turns.
          for (let i = 0; i < 6; i++) {
            yield* llm.pushMatch(marker("workload-delta"), reply().tool("bash", { command: "seq 1 40000" }))
          }
          yield* llm.pushMatch(marker("workload-delta"), reply().text("delta pass one done").stop())
          yield* llm.pushMatch(marker("workload-delta"), reply().text("delta pass two done").stop())
          yield* llm.pushMatch(marker("workload-delta"), reply().text("delta pass three done").stop())

          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const reflection = yield* Reflection.Service
          const store = yield* SessionStore.Service
          const gammaReady = yield* Deferred.make<SessionSchema.ID>()
          const permission = [{ permission: "*", pattern: "*", action: "allow" as const }]
          const drive = (title: string, text: string) =>
            Effect.gen(function* () {
              const session = yield* sessions.create({ title, permission })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text }],
              })
              yield* prompt.loop({ sessionID: session.id })
              return session.id
            })

          // gamma runs two sequential drains on ONE session. Publishes its ID
          // as soon as it exists so the reflection leg can drive the cadence
          // state machine against a live, draining session.
          const gammaFlow = Effect.gen(function* () {
            const gammaID = yield* drive("gamma", "workload-gamma: first pass")
            yield* Deferred.succeed(gammaReady, gammaID)
            yield* prompt.prompt({
              sessionID: gammaID,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "workload-gamma: second pass" }],
            })
            yield* prompt.loop({ sessionID: gammaID })
            return gammaID
          })

          // delta needs three sequential drains: prune protects tool output
          // inside the last two user turns, so the fat transcript must sit at
          // least two turns behind the head.
          const deltaFlow = Effect.gen(function* () {
            const deltaID = yield* drive("delta", "workload-delta: fat output")
            for (const text of ["workload-delta: second pass", "workload-delta: third pass"]) {
              yield* prompt.prompt({
                sessionID: deltaID,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text }],
              })
              yield* prompt.loop({ sessionID: deltaID })
            }
            return deltaID
          })

          // Reflection cadence under load: real storage CAS writes while other
          // sessions drain. recordCompletion → due → prompt claim → complete is
          // the same cycle the V2 drain drives through llm.ts.
          const reflectionFlow = Effect.gen(function* () {
            const gammaID = yield* Deferred.await(gammaReady)
            const info = yield* store.get(gammaID)
            expect(info).toBeDefined()
            yield* reflection.updateWork(gammaID, {
              prediction: "subagent writes land before search probes",
              hypotheses: [
                { claim: "child writes churn the index", status: "open" },
                { claim: "vocab embeds stay bounded", status: "supported", evidence: "potionCalls" },
              ],
              nextAction: "assert vocab call count after storm",
            })
            yield* reflection.recordCompletion({ session: info!, interval: 1 })
            yield* reflection.recordCompletion({ session: info!, completionID: "msg_second", interval: 1 })
            expect(yield* reflection.due({ session: info!, interval: 1 })).toBe(true)
            const checkpoint = yield* reflection.prompt({ session: info!, enabled: true, interval: 1, claim: true })
            expect(checkpoint).toContain("<reflection_checkpoint>")
            expect(
              yield* reflection.complete(info!, {
                critique: "verified drains before claiming quiet",
                lessons: ["drive cadence through the service, not the drain"],
                memories: [],
              }),
            ).toBe(true)
            expect(yield* reflection.due({ session: info!, interval: 1 })).toBe(false)
            const work = yield* reflection.work(gammaID)
            expect(work?.hypotheses).toHaveLength(2)
          })

          const ptyLoop = Effect.gen(function* () {
            for (let i = 0; i < 3; i++) {
              const created = yield* requestInDirectory("/pty", dir, {
                method: "POST",
                body: JSON.stringify({
                  command: "/bin/sh",
                  args: ["-c", "echo pty-smoke; sleep 30"],
                  cwd: dir,
                  title: `smoke-${i}`,
                }),
              })
              expect(created.status).toBe(200)
              const info = yield* Schema.decodeUnknownEffect(Pty.Info)(yield* created.json).pipe(Effect.orDie)
              const updated = yield* requestInDirectory(`/pty/${info.id}`, dir, {
                method: "PUT",
                body: JSON.stringify({ size: { rows: 40, cols: 120 } }),
              })
              expect(updated.status).toBe(200)
              const listed = yield* requestInDirectory("/pty", dir)
              expect(listed.status).toBe(200)
              const removed = yield* requestInDirectory(`/pty/${info.id}`, dir, { method: "DELETE" })
              expect(removed.status).toBe(200)
            }
          })

          // An extra bus flood on top of the workload's own event volume.
          const flood = yield* Effect.gen(function* () {
            for (let i = 0; i < 1200; i++) {
              GlobalBus.emit("event", {
                directory: "probe",
                payload: { type: "workload.flood", properties: { i, pad: "x".repeat(1024) } },
              })
              if (i % 96 === 0) yield* Effect.yieldNow
            }
          }).pipe(Effect.forkScoped)

          const [, , deltaID, , , , searchRuns] = yield* Effect.all(
            [
              drive("alpha", "workload-alpha: shells then swarm"),
              gammaFlow,
              deltaFlow,
              drive("beta", "workload-beta: writes then search"),
              ptyLoop,
              reflectionFlow,
              Effect.gen(function* () {
                const locations = yield* LocationServiceMap.Service
                const locationLayer = locations.get(Location.Ref.make({ directory: AbsolutePath.make(dir) }))
                const search = yield* CodeSearch.Service.pipe(Effect.provide(locationLayer))
                const probes: number[] = []
                // Searches overlap the agents' writes — each dirty bump would
                // re-embed the whole vocabulary without the debounce.
                for (let i = 0; i < 6; i++) {
                  const [, ms] = yield* timed(search.search({ queries: ["reconcile watcher churn"] }))
                  probes.push(ms)
                  yield* Effect.sleep("150 millis")
                }
                return probes
              }),
            ],
            { concurrency: "unbounded" },
          )

          // Probes measured while the storm was still settling.
          const [list, listMs] = yield* timed(requestInDirectory("/session", dir))
          expect(list.status).toBe(200)
          const [, healthMs] = yield* timed(request(GlobalPaths.health))

          // Compaction prune over delta's fat transcript — must actually flag
          // parts, not just return quickly on a no-op scan.
          const compaction = yield* SessionCompaction.Service
          const [, pruneMs] = yield* timed(compaction.prune({ sessionID: deltaID }))
          const pruned = (yield* sessions.messages({ sessionID: deltaID })).flatMap((msg) =>
            msg.parts.filter((part) => part.type === "tool" && part.state.status === "completed" && part.state.time.compacted),
          )
          expect(pruned.length).toBeGreaterThan(0)

          // Wait for the mock to go quiet — child settle wakes can still fire.
          yield* awaitWithTimeout(
            Effect.gen(function* () {
              let last = -1
              while (true) {
                const calls = yield* llm.calls
                if (calls === last) return
                last = calls
                yield* Effect.sleep("800 millis")
              }
            }),
            "mock LLM traffic never went quiet",
            "60 seconds",
          )

          // All three subagents actually spawned and drove turns — each child
          // prompt carries its swarm-child marker into provider requests.
          const hits = yield* llm.hits
          for (let c = 0; c < 3; c++) {
            expect(hits.some((hit) => JSON.stringify(hit.body).includes(`swarm-child-${c}`))).toBe(true)
          }

          // Every tab saw exactly one connect — no reconnects, no resyncs —
          // and the stream still flows after the storm.
          GlobalBus.emit("event", {
            directory: "probe",
            payload: { type: "workload.probe", properties: {} },
          })
          yield* Effect.all(
            tabs.map((tab, i) =>
              Effect.gen(function* () {
                expect(tab.parser.all.filter((event) => event.type === "server.connected")).toHaveLength(1)
                yield* tab.until((event) => event.type === "workload.probe", `tab ${i} lost the stream mid-storm`)
              }),
            ),
            { concurrency: "unbounded" },
          )

          console.log("persona probes", {
            listMs,
            healthMs,
            pruneMs,
            searchMs: searchRuns,
            vocabEmbeds: potionCalls.vocab,
            queryEmbeds: potionCalls.query,
          })
          expect(listMs).toBeLessThan(10_000)
          expect(healthMs).toBeLessThan(5_000)
          expect(pruneMs).toBeLessThan(10_000)
          expect(flood).toBeDefined()
        }),
      ),
      {
        config: {
          formatter: false,
          lsp: false,
          compaction: { prune: true },
          reflection: { enabled: true, every_sessions: 1 },
          // Lift the per-part output bound so delta's fat tool outputs store at
          // ~200KB each — the prune window needs >60k tokens of tool output.
          tool_output: { max_lines: 100_000, max_bytes: 512 * 1024 },
        } as Partial<ConfigV1.Info>,
      },
    ),
    180_000,
  )
})
