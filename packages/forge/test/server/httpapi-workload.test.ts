// Reproduces the 1.0.34 all-tabs-refresh regression: concurrent subagent +
// shell drains produce an event burst that filled the SSE subscriber bound
// (256) faster than a busy renderer could drain it. The stream failed, the
// client reconnected, and `server.connected` re-bootstrapped every tab.
// The subscriber bound is now the EventV2 pubsub bound (8192); a stalled
// reader must absorb a realistic burst without the stream dying.

import { afterEach, describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Exit, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Shell } from "@turenlabs/core/shell"
import { FSUtil } from "@turenlabs/core/fs-util"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MCP } from "../../src/mcp"
import { LSP } from "../../src/lsp/lsp"
import { GlobalBus } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { reply, TestLLMServer } from "../lib/llm-server"
import { awaitWithTimeout, pollWithTimeout, testEffectShared } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { httpApiLayer, request } from "./httpapi-layer"

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

const stack = Layer.mergeAll(
  httpApiLayer,
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      testLLMServerNode,
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [Provider.node, providerNode],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

// Shared memoMap so the drain's EventV2 publications reach the HTTP SSE route.
const it = testEffectShared(stack)

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
  const all: { type: string; directory?: string; properties?: Record<string, unknown> }[] = []
  return {
    all,
    feed(parts: Iterable<Uint8Array>) {
      for (const part of parts) buffer += decoder.decode(part, { stream: true })
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      const events = frames
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => {
          const envelope = Schema.decodeUnknownSync(EventData)(JSON.parse(frame.slice(6)))
          return { ...envelope.payload, directory: envelope.directory }
        })
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
            (event) => event.directory !== undefined && event.directory !== "probe",
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
      ),
    120_000,
  )
})
