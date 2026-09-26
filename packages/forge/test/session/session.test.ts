import { describe, expect } from "bun:test"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { EventV2 } from "@turenlabs/core/event"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { McpBroker } from "@/mcp/broker"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"

const graph = LayerNode.group([
  SessionNs.node,
  EventV2Bridge.node,
  SessionProjector.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
])
const replacements: LayerNode.Replacements = [
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
  [
    InstanceBootstrap.node,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
]
const it = testEffect(AppNodeBuilder.build(graph, replacements))
// Format detectors only, with an outage switch for the credential snapshot.
const protection = { available: true }
const guarded = testEffect(
  AppNodeBuilder.build(graph, [
    ...replacements,
    [
      SecretOutput.node,
      Layer.succeed(
        SecretOutput.Service,
        SecretOutput.Service.of({
          snapshot: () =>
            protection.available
              ? Effect.succeed(SecretRedaction)
              : Effect.fail(new SecretOutput.Error({ message: "Secret output protection unavailable" })),
        }),
      ),
    ],
  ]),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  for (const status of ["running", "completed", "error"] as const) {
    it.instance(`redacts ${status} tool output before event and database persistence`, () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})
        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        })
        const secret = `ghp_${"D".repeat(36)}`
        const seen: unknown[] = []
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === SessionV1.Event.PartUpdated.type) seen.push(event.data)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        const base = { input: {}, metadata: { nested: [secret], [secret]: "value" }, time: { start: 1, end: 2 } }
        const state: SessionV1.ToolState =
          status === "completed"
            ? { ...base, status, output: secret, title: secret }
            : status === "error"
              ? { ...base, status, error: secret }
              : { ...base, status, title: secret }
        const part = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "tool" as const,
          tool: "bash",
          callID: "secret-test",
          state,
        }
        const result = yield* session.updatePart(part)
        const saved = yield* session.getPart({ sessionID: info.id, messageID, partID: part.id })
        expect(JSON.stringify(saved)).not.toContain(secret)
        expect(JSON.stringify(result)).not.toContain(secret)
        expect(JSON.stringify(seen)).not.toContain(secret)
        expect(JSON.stringify(saved)).toContain("[SECRET:v1:")
        expect(part.state).toEqual(state)
        yield* session.remove(info.id)
      }),
    )
  }

  const toolMessage = Effect.fn("SessionTest.toolMessage")(function* () {
    const session = yield* SessionNs.Service
    const info = yield* session.create({})
    const messageID = MessageID.ascending()
    yield* session.updateMessage({
      id: messageID,
      sessionID: info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    })
    return { session, info, messageID }
  })

  it.instance("keeps JSON-compatible tool metadata while redacting it, instead of discarding all of it", () =>
    Effect.gen(function* () {
      const { session, info, messageID } = yield* toolMessage()
      const secret = `ghp_${"M".repeat(36)}`
      class FileDiff {
        constructor(
          readonly file: string,
          readonly after: string,
        ) {}
      }
      const part = {
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "tool" as const,
        tool: "edit",
        callID: "metadata-shape",
        state: {
          status: "completed" as const,
          input: {},
          output: "ok",
          title: "a.ts",
          time: { start: 1, end: 2 },
          metadata: {
            at: new Date(0),
            ratio: Number.NaN,
            filediff: new FileDiff("a.ts", `token=${secret}`),
            diagnostics: { "a.ts": [{ message: "unused" }] },
          },
        },
      }
      yield* session.updatePart(part)
      const saved = yield* session.getPart({ sessionID: info.id, messageID, partID: part.id })
      const state = saved?.type === "tool" ? saved.state : undefined
      expect(state?.status).toBe("completed")
      const metadata = state?.status === "completed" ? state.metadata : undefined
      expect(JSON.stringify(saved)).not.toContain(secret)
      expect(metadata).toMatchObject({
        at: "1970-01-01T00:00:00.000Z",
        ratio: null,
        filediff: { file: "a.ts", after: expect.stringMatching(/^token=\[SECRET:v1:github:/) },
        diagnostics: { "a.ts": [{ message: "unused" }] },
      })
      yield* session.remove(info.id)
    }),
  )

  it.instance("leaves opaque provider metadata on tool parts byte-for-byte intact", () =>
    Effect.gen(function* () {
      const { session, info, messageID } = yield* toolMessage()
      const providerMetadata = {
        providerExecuted: true,
        google: { thoughtSignature: `c2ln/ghp_${"S".repeat(36)}/+==` },
      }
      const part = {
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "tool" as const,
        tool: "web_search",
        callID: "provider-metadata",
        state: { status: "running" as const, input: {}, time: { start: 1 } },
        metadata: providerMetadata,
      }
      yield* session.updatePart(part)
      const saved = yield* session.getPart({ sessionID: info.id, messageID, partID: part.id })
      expect(saved?.type === "tool" ? saved.metadata : undefined).toEqual(providerMetadata)
      yield* session.remove(info.id)
    }),
  )

  guarded.instance("a transient protection outage preserves stored tool output and withholds only new text", () =>
    Effect.gen(function* () {
      const { session, info, messageID } = yield* toolMessage()
      const secret = `ghp_${"H".repeat(36)}`
      const stored = {
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "tool" as const,
        tool: "bash",
        callID: "historical",
        state: {
          status: "completed" as const,
          input: {},
          output: `listing ${secret}`,
          title: "ls",
          metadata: { exit: 0 },
          time: { start: 1, end: 2 },
        },
      }
      yield* session.updatePart(stored)
      const persisted = yield* session.getPart({ sessionID: info.id, messageID, partID: stored.id })
      if (persisted?.type !== "tool" || persisted.state.status !== "completed") throw new Error("missing part")
      const historical = persisted.state
      expect(historical.output).toContain("[SECRET:v1:github:")

      protection.available = false
      const outcome = yield* Effect.gen(function* () {
        // Compaction re-saves a historical part with only a time mark changed.
        yield* session.updatePart({
          ...persisted,
          state: { ...historical, time: { ...historical.time, compacted: 3 } },
        })
        const pruned = yield* session.getPart({ sessionID: info.id, messageID, partID: stored.id })
        // A live update with new text must never persist it raw while protection is down.
        const live = { ...stored, id: PartID.ascending(), callID: "live" }
        yield* session.updatePart({ ...live, state: { ...live.state, output: `fresh ${secret}` } })
        const fresh = yield* session.getPart({ sessionID: info.id, messageID, partID: live.id })
        return { pruned, fresh }
      }).pipe(Effect.ensuring(Effect.sync(() => (protection.available = true))))

      const pruned = outcome.pruned?.type === "tool" ? outcome.pruned.state : undefined
      expect(pruned?.status === "completed" && pruned.output).toBe(historical.output)
      expect(pruned?.status === "completed" && pruned.title).toBe("ls")
      expect(pruned?.status === "completed" && pruned.time.compacted).toBe(3)
      expect(JSON.stringify(outcome.fresh)).not.toContain(secret)
      expect(JSON.stringify(outcome.fresh)).toContain("withheld")
      yield* session.remove(info.id)
    }),
  )

  it.instance("clears broker selections for a removed session tree", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const parent = yield* session.create({ title: "broker-parent" })
      const child = yield* session.create({ parentID: parent.id, title: "broker-child" })
      const capabilities = [McpBroker.capability({ key: "test_tool", server: "test", name: "tool" })]

      expect(McpBroker.load(parent.id, capabilities, ["test_tool"]).loaded).toEqual(["test_tool"])
      expect(McpBroker.load(child.id, capabilities, ["test_tool"]).loaded).toEqual(["test_tool"])

      yield* session.remove(parent.id)

      expect(McpBroker.selected(parent.id, capabilities)).toEqual([])
      expect(McpBroker.selected(child.id, capabilities)).toEqual([])
    }),
  )

  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
