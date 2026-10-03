import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionReplay } from "@turenlabs/core/session/replay"
import { SessionStore } from "@turenlabs/core/session/store"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { RecallTool } from "@turenlabs/core/tool/recall"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location as locationFixture } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const directory = AbsolutePath.make("/project")
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      RecallTool.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(locationFixture({ directory })))],
    ],
  ),
)
const location = Location.Ref.make({ directory })
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

type Result = { readonly type: string; readonly value?: unknown }
// The registry refuses to reuse a call identity for a different request, so every call gets its own.
let calls = 0
const call = (sessionID: SessionV2.ID, input: unknown, id = `call_recall_${++calls}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: RecallTool.name, input },
})

// One assistant step with a bash call and its result, so the session has searchable tool history.
const seedTool = (sessionID: SessionV2.ID, callID: string, command: string, output: string, at: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const assistantMessageID = SessionMessage.ID.create()
    const time = (offset: number) => DateTime.makeUnsafe(Date.parse(at) + offset)
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      timestamp: time(0),
      assistantMessageID,
      agent: "build",
      model,
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      timestamp: time(1_000),
      assistantMessageID,
      callID,
      tool: "bash",
      input: { command },
      provider: { executed: false },
    })
    yield* events.publish(SessionEvent.Tool.Success, {
      sessionID,
      timestamp: time(2_000),
      assistantMessageID,
      callID,
      structured: {},
      content: [{ type: "text", text: output }],
      provider: { executed: false },
    })
  })

const index = Effect.gen(function* () {
  const db = Database.primary((yield* Database.Service).db)
  yield* SessionReplay.ensure(db)
  yield* SessionReplay.enable(db)
  for (let batch = 0; batch < 5; batch++) yield* SessionReplay.backfillBatch(db)
})

const run = (sessionID: SessionV2.ID, input: unknown) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return (yield* executeTool(registry, call(sessionID, input))) as Result
  })

const value = (result: Result) => {
  expect(result.type).toBe("json")
  return result.value as {
    mode: "search" | "read"
    total?: number
    matches?: ReadonlyArray<{ id: string; type: string; preview: string }>
    events?: ReadonlyArray<{ id: string; type: string; content: string }>
    before?: string
    after?: string
    next_cursor?: string
  }
}

describe("session_recall", () => {
  it.effect("is registered as a built-in tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("session_recall")
    }),
  )

  it.effect("finds an earlier command and reads the events around it, with their full content", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const mine = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      yield* seedTool(mine.id, "call_one", "bun typecheck --force", "error TS2345: bad argument in packages/core", "2026-08-20T12:00:00.000Z")
      yield* seedTool(mine.id, "call_two", "ls -la", "total 0", "2026-08-20T12:05:00.000Z")
      yield* index

      const found = value(yield* run(mine.id, { query: "typecheck" }))
      expect(found.mode).toBe("search")
      const hit = found.matches?.find((match) => match.type.includes("tool") && match.preview.includes("typecheck"))
      expect(hit).toBeDefined()

      const read = value(yield* run(mine.id, { around: hit!.id, limit: 10 }))
      expect(read.mode).toBe("read")
      const text = (read.events ?? []).map((event) => event.content).join("\n")
      expect(text).toContain("bun typecheck --force")
      expect(text).toContain("error TS2345")
    }),
  )

  it.effect("only ever sees its own session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const mine = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      const other = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      yield* seedTool(mine.id, "call_mine", "echo mine", "mine-output", "2026-08-20T12:00:00.000Z")
      yield* seedTool(other.id, "call_other", "echo secret", "BRAVO_ONLY_IN_THE_OTHER_SESSION", "2026-08-20T12:00:00.000Z")
      yield* index

      expect(value(yield* run(mine.id, { query: "BRAVO_ONLY_IN_THE_OTHER_SESSION" })).matches).toEqual([])
      const theirs = value(yield* run(other.id, { query: "BRAVO_ONLY_IN_THE_OTHER_SESSION" }))
      expect(theirs.matches?.length).toBeGreaterThan(0)

      // An event id from another session cannot be read, even with the right id.
      const stolen = yield* run(mine.id, { around: theirs.matches![0]!.id })
      expect(stolen.type).toBe("error")
    }),
  )

  it.effect("rejects a session filter instead of letting the caller widen the search", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const mine = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      const other = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      yield* seedTool(other.id, "call_other", "echo secret", "CHARLIE_ONLY_IN_THE_OTHER_SESSION", "2026-08-20T12:00:00.000Z")
      yield* index

      for (const query of [`session:${other.id} CHARLIE`, `CHARLIE -session:${mine.id}`]) {
        const result = yield* run(mine.id, { query })
        expect(result.type).toBe("error")
        expect(String(result.value)).toContain("current session")
      }
    }),
  )

  it.effect("needs exactly one of query and around", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const mine = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      expect((yield* run(mine.id, {})).type).toBe("error")
      expect((yield* run(mine.id, { query: "x", around: "evt_x" })).type).toBe("error")
      expect((yield* run(mine.id, { query: "   " })).type).toBe("error")
      expect((yield* run(mine.id, { around: "not-an-event" })).type).toBe("error")
    }),
  )

  it.effect("reports a malformed query as a tool error the model can correct", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const mine = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      yield* index
      const result = yield* run(mine.id, { query: 'tool:"unterminated' })
      expect(result.type).toBe("error")
    }),
  )

  it.effect("bounds the number of results", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const mine = yield* session.create({ location, agent: AgentV2.ID.make("build"), model })
      for (let n = 0; n < 6; n++)
        yield* seedTool(mine.id, `call_${n}`, `echo repeated-${n}`, "repeated output", `2026-08-20T12:0${n}:00.000Z`)
      yield* index

      expect(value(yield* run(mine.id, { query: "repeated", limit: 2 })).matches?.length).toBeLessThanOrEqual(2)
      expect(value(yield* run(mine.id, { query: "repeated", limit: 9_999 })).matches?.length).toBeLessThanOrEqual(25)
    }),
  )
})

describe("clip", () => {
  test("keeps the start and the end of long text, where a command and its error usually are", () => {
    const text = `START${"x".repeat(5_000)}END`
    const clipped = RecallTool.clip(text, 200)
    expect(clipped.length).toBeLessThan(260)
    expect(clipped.startsWith("START")).toBe(true)
    expect(clipped.endsWith("END")).toBe(true)
    expect(clipped).toContain("characters omitted")
  })

  test("leaves short text alone", () => {
    expect(RecallTool.clip("short", 200)).toBe("short")
  })
})
