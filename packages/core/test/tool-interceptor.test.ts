import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { Database } from "@turenlabs/core/database/database"
import { makeLocationNode } from "@turenlabs/core/effect/app-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ReferenceGuidance } from "@turenlabs/core/reference/guidance"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionRunCoordinator } from "@turenlabs/core/session/run-coordinator"
import { SessionRunner } from "@turenlabs/core/session/runner"
import * as SessionRunnerLLM from "@turenlabs/core/session/runner/llm"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { Snapshot } from "@turenlabs/core/snapshot"
import { SystemContext } from "@turenlabs/core/system-context"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Deferred, Duration, Effect, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

// ---------------------------------------------------------------------------
// Registry-level rig. The interceptors run inside `ToolRegistry`, so these
// exercise the real decode/execute/encode/bound chain without a provider.
// ---------------------------------------------------------------------------

const executions: unknown[] = []
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const registryOnly = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolInterceptor.node]), [
    [ToolOutputStore.node, outputStore],
  ]),
)

const sessionID = SessionV2.ID.make("ses_interceptor")
const call = (input: unknown, name = "echo", id = "call-1"): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call", id, name, input },
})

/** Echoes text and records what it was actually asked to do, so a skipped call is visible. */
const echo = Tool.make({
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: (input) => Effect.sync(() => executions.push(input)).pipe(Effect.as(input)),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})

/** Structured-only output: no `toModelOutput`, so the settled result is `{ type: "json" }`. */
const counter = Tool.make({
  description: "Count",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ length: Schema.Number }),
  execute: (input) => Effect.sync(() => executions.push(input)).pipe(Effect.as({ length: input.text.length })),
})

const registerTools = Effect.gen(function* () {
  executions.length = 0
  const registry = yield* ToolRegistry.Service
  yield* registry.register({ echo, counter })
  return registry
})

describe("ToolInterceptor at the settlement boundary", () => {
  registryOnly.effect("settles unchanged when nothing is registered", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const settlement = yield* settleTool(registry, call({ text: "hello" }))

      expect(settlement.result).toEqual({ type: "text", value: "hello" })
      expect(executions).toEqual([{ text: "hello" }])
    }),
  )

  registryOnly.effect("denies before the tool runs and reports the reason to the model", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      const observed: ToolInterceptor.AfterEvent[] = []
      yield* interceptors.hook.before((event) => {
        event.decision = { type: "deny", reason: "blocked by policy" }
      })
      yield* interceptors.hook.after((event) => {
        observed.push(event)
      })

      const settlement = yield* settleTool(registry, call({ text: "hello" }))

      expect(settlement.result).toEqual({ type: "error", value: "blocked by policy" })
      // The whole point of a veto: the side effect never happened.
      expect(executions).toEqual([])
      expect(observed).toMatchObject([{ denied: true, tool: "echo", result: { type: "error" } }])
    }),
  )

  registryOnly.effect("re-decodes a replacement through the tool's own input schema", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      yield* interceptors.hook.before((event) => {
        event.decision = { type: "replace", input: { text: "sanitized" } }
      })

      const settlement = yield* settleTool(registry, call({ text: "raw" }))

      expect(settlement.result).toEqual({ type: "text", value: "sanitized" })
      expect(executions).toEqual([{ text: "sanitized" }])
    }),
  )

  registryOnly.effect("rejects a replacement the tool's input schema does not accept", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      yield* interceptors.hook.before((event) => {
        event.decision = { type: "replace", input: { text: 42 } }
      })

      const settlement = yield* settleTool(registry, call({ text: "raw" }))

      expect(settlement.result.type).toBe("error")
      expect(String(settlement.result.value)).toContain("Invalid tool input")
      // A plugin cannot smuggle in a shape the tool never validated.
      expect(executions).toEqual([])
    }),
  )

  registryOnly.effect("composes replacements in registration order and lets a deny win", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      const seen: unknown[] = []
      yield* interceptors.hook.before((event) => {
        seen.push(event.input)
        event.decision = { type: "replace", input: { text: "first" } }
      })
      yield* interceptors.hook.before((event) => {
        seen.push(event.input)
        event.decision = { type: "replace", input: { text: `${(event.input as { text: string }).text}+second` } }
      })

      expect((yield* settleTool(registry, call({ text: "raw" }))).result).toEqual({
        type: "text",
        value: "first+second",
      })
      expect(seen).toEqual([{ text: "raw" }, { text: "first" }])

      // A deny is terminal: the interceptor registered after it is never consulted, so a security
      // veto cannot be reversed by whatever plugin happens to load next.
      executions.length = 0
      const consulted: string[] = []
      yield* interceptors.hook.before((event) => {
        consulted.push("denier")
        event.decision = { type: "deny", reason: "no" }
      })
      yield* interceptors.hook.before(() => {
        consulted.push("later")
      })

      expect((yield* settleTool(registry, call({ text: "raw" }, "echo", "call-denied"))).result).toEqual({
        type: "error",
        value: "no",
      })
      expect(consulted).toEqual(["denier"])
      expect(executions).toEqual([])
    }),
  )

  registryOnly.effect("treats a throwing or dying interceptor as having no opinion", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      yield* interceptors.hook.before(() => {
        throw new Error("plugin exploded")
      })
      yield* interceptors.hook.before(() => Effect.die("plugin died"))
      const reached: string[] = []
      yield* interceptors.hook.before(() => {
        reached.push("survivor")
      })

      const settlement = yield* settleTool(registry, call({ text: "hello" }))

      expect(settlement.result).toEqual({ type: "text", value: "hello" })
      expect(reached).toEqual(["survivor"])
      expect(executions).toEqual([{ text: "hello" }])
    }),
  )

  registryOnly.effect("bounds an interceptor that never returns", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      const started = yield* Deferred.make<void>()
      const stuck = yield* Deferred.make<void>()
      yield* interceptors.hook.before(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(stuck))),
      )

      const fiber = yield* Effect.forkChild(settleTool(registry, call({ text: "hello" })))
      yield* Deferred.await(started)
      yield* TestClock.adjust("31 seconds")
      const settlement = yield* Fiber.join(fiber)

      expect(settlement.result).toEqual({ type: "text", value: "hello" })
      expect(executions).toEqual([{ text: "hello" }])
    }),
  )

  registryOnly.effect("appends after-notes without losing a structured result", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      yield* interceptors.hook.after((event) => {
        event.notes.push(`scanned ${event.tool}`)
      })

      const text = yield* settleTool(registry, call({ text: "hello" }))
      expect(text.result).toEqual({
        type: "content",
        value: [
          { type: "text", text: "hello" },
          { type: "text", text: "scanned echo" },
        ],
      })
      expect(text.output).toMatchObject({ structured: { text: "hello" } })

      // A json-only tool has no content to append to. Rendering the structured value as the
      // leading part is what stops the annotation from evicting the result itself.
      const structured = yield* settleTool(registry, call({ text: "hello" }, "counter", "call-2"))
      expect(structured.result).toEqual({
        type: "content",
        value: [
          { type: "text", text: '{"length":5}' },
          { type: "text", text: "scanned counter" },
        ],
      })
      expect(structured.output).toMatchObject({ structured: { length: 5 } })
    }),
  )

  registryOnly.effect("appends advisory notes to a failed settlement", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      const observed: ToolInterceptor.AfterEvent[] = []
      yield* interceptors.hook.after((event) => {
        observed.push(event)
        event.notes.push("note")
      })

      const settlement = yield* settleTool(registry, call({ text: 1 }))

      expect(settlement.result.type).toBe("error")
      expect(String(settlement.result.value)).toContain("Invalid tool input")
      expect(String(settlement.result.value)).toContain("note")
      expect(observed).toMatchObject([{ denied: false, result: { type: "error" } }])
      expect(settlement.output).toBeUndefined()
    }),
  )

  registryOnly.effect("caps how much interceptor text reaches the model", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      yield* interceptors.hook.after((event) => {
        for (let index = 0; index < 20; index++) event.notes.push(`note-${index}`)
        event.notes.push("x".repeat(10_000))
      })

      const settlement = yield* settleTool(registry, call({ text: "hello" }))

      const parts: ReadonlyArray<{ readonly type: string; readonly text?: string }> =
        settlement.result.type === "content" ? settlement.result.value : []
      // One tool text part plus the note cap.
      expect(parts).toHaveLength(9)
      expect(parts.every((part) => part.type === "text" && (part.text?.length ?? 0) <= 4_001)).toBe(true)
    }),
  )

  registryOnly.effect("stops running an interceptor once its scope closes", () =>
    Effect.gen(function* () {
      const registry = yield* registerTools
      const interceptors = yield* ToolInterceptor.Service
      const scope = yield* Scope.make()
      yield* interceptors.hook
        .before((event) => {
          event.decision = { type: "deny", reason: "temporarily blocked" }
        })
        .pipe(Scope.provide(scope))

      expect((yield* settleTool(registry, call({ text: "hello" }))).result).toEqual({
        type: "error",
        value: "temporarily blocked",
      })

      yield* Scope.close(scope, undefined as never)

      expect((yield* settleTool(registry, call({ text: "hello" }, "echo", "call-after-close"))).result).toEqual({
        type: "text",
        value: "hello",
      })
    }),
  )
})

// ---------------------------------------------------------------------------
// End-to-end rig. One fake provider turn emits a real tool call, the real
// runner settles it through the real registry into a real filesystem side
// effect, and the projected transcript is the assertion. Nothing here is
// hand-fed to the interceptor.
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tool-interceptor-"))
let responses: LLMEvent[][] = []
const requests: LLMRequest[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses.shift() ?? [])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed({
    model,
    ref: ModelV2.Ref.make({ id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider) }),
    cost: [],
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

/** A tool whose success is observable outside the transcript: it writes a real file. */
const scratchWrite = Tool.make({
  description: "Write a scratch file",
  input: Schema.Struct({ name: Schema.String, content: Schema.String }),
  output: Schema.Struct({ bytes: Schema.Number }),
  execute: (input) =>
    Effect.sync(() => {
      const target = path.join(scratch, path.basename(input.name))
      fs.writeFileSync(target, input.content)
      return { bytes: Buffer.byteLength(input.content) }
    }),
  toModelOutput: ({ output }) => [{ type: "text", text: `wrote ${output.bytes} bytes` }],
})
const toolsLayer = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) => registry.register({ scratch_write: scratchWrite })),
)
const toolsNode = makeLocationNode({
  name: "test/tool-interceptor-tools",
  layer: toolsLayer,
  deps: [ToolRegistry.node],
})
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const directory = AbsolutePath.make(import.meta.dir)
const replacements = [
  [LayerNodePlatform.llmClient, client],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [Snapshot.node, Snapshot.noopLayer],
] as const
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, replacements as never)
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (id, force, control) => runner.run({ sessionID: id, force, control }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      claimResume: coordinator.claim,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const endToEnd = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolInterceptor.node,
      toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionV2.node,
    ]),
    [...replacements, [SessionExecution.node, execution]] as never,
  ),
)

const turn = (input: unknown, id: string) => [
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id, name: "scratch_write", input }),
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

const prepare = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    requests.length = 0
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory,
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

describe("ToolInterceptor through a real provider turn", () => {
  endToEnd.effect("stops a real side effect and annotates a real settled result", () =>
    Effect.gen(function* () {
      const denied = SessionV2.ID.make("ses_interceptor_denied")
      yield* prepare(denied)
      const interceptors = yield* ToolInterceptor.Service
      const seen: ToolInterceptor.AfterEvent[] = []
      // Shaped like a security scanner: inspect the raw arguments, refuse the dangerous ones,
      // annotate the ones that were allowed through.
      yield* interceptors.hook.before((event) => {
        const content = (event.input as { content?: unknown }).content
        if (typeof content === "string" && content.includes("eval("))
          event.decision = { type: "deny", reason: "Batou blocked this write: unsafe eval" }
      })
      yield* interceptors.hook.after((event) => {
        seen.push(event)
        if (!event.denied) event.notes.push("Batou: no security issues detected")
      })

      const session = yield* SessionV2.Service
      responses = turn({ name: "danger.js", content: "eval(userInput)" }, "call-denied")
      yield* session.prompt({ sessionID: denied, prompt: Prompt.make({ text: "write it" }), resume: false })
      yield* session.resume(denied)

      // The real filesystem is the witness: settlement never reached the tool.
      expect(fs.existsSync(path.join(scratch, "danger.js"))).toBe(false)
      expect(yield* session.context(denied)).toMatchObject([
        { type: "user", text: "write it" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-denied",
              name: "scratch_write",
              state: { status: "error", error: { message: "Batou blocked this write: unsafe eval" } },
            },
          ],
        },
        { type: "assistant", content: [{ type: "text", text: "Done" }] },
      ])
      expect(seen).toMatchObject([{ denied: true, tool: "scratch_write", sessionID: denied }])
      // The denial is what the *next* provider turn carries, not a silently dropped call.
      expect(requests).toHaveLength(2)

      const allowed = SessionV2.ID.make("ses_interceptor_allowed")
      yield* prepare(allowed)
      seen.length = 0
      responses = turn({ name: "safe.txt", content: "hello" }, "call-allowed")
      yield* session.prompt({ sessionID: allowed, prompt: Prompt.make({ text: "write it" }), resume: false })
      yield* session.resume(allowed)

      expect(fs.readFileSync(path.join(scratch, "safe.txt"), "utf8")).toBe("hello")
      expect(seen).toMatchObject([
        { denied: false, tool: "scratch_write", result: { type: "text", value: "wrote 5 bytes" } },
      ])
      expect(yield* session.context(allowed)).toMatchObject([
        { type: "user", text: "write it" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-allowed",
              state: {
                status: "completed",
                structured: { bytes: 5 },
                content: [
                  { type: "text", text: "wrote 5 bytes" },
                  { type: "text", text: "Batou: no security issues detected" },
                ],
              },
            },
          ],
        },
        { type: "assistant", content: [{ type: "text", text: "Done" }] },
      ])
    }),
  )

  /**
   * The same contract, but for a batch: one assistant message issuing three independent calls,
   * which the runner settles concurrently.
   *
   * On the live clock, because the interesting claim is a timing one. `before` and `after` budgets
   * are whole-phase *per settlement*, so three calls that each sit in a 100ms interceptor cost one
   * delay, not three -- and if a shared budget or a serialised boundary ever crept in, this would
   * take three times as long rather than merely reordering. A rig with instant interceptors could
   * not tell those apart.
   */
  endToEnd.live("applies deny, replace and annotate per call across a concurrently settled batch", () =>
    Effect.gen(function* () {
      const batched = SessionV2.ID.make("ses_interceptor_batch")
      yield* prepare(batched)
      const interceptors = yield* ToolInterceptor.Service
      const seen: ToolInterceptor.AfterEvent[] = []
      let active = 0
      let maxActive = 0
      yield* interceptors.hook.before((event) =>
        Effect.gen(function* () {
          active += 1
          maxActive = Math.max(maxActive, active)
          yield* Effect.sleep(Duration.millis(100))
          active -= 1
          const input = event.input as { readonly name?: unknown; readonly content?: unknown }
          if (typeof input.content === "string" && input.content.includes("eval("))
            event.decision = { type: "deny", reason: "Batou blocked this write: unsafe eval" }
          else if (input.name === "batch-rewrite.txt")
            event.decision = { type: "replace", input: { ...input, content: "replaced" } }
        }),
      )
      yield* interceptors.hook.after((event) =>
        Effect.sync(() => {
          seen.push(event)
          if (!event.denied) event.notes.push(`Batou: checked ${event.callID}`)
        }),
      )

      const session = yield* SessionV2.Service
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "batch-safe",
            name: "scratch_write",
            input: { name: "batch-safe.txt", content: "safe" },
          }),
          LLMEvent.toolCall({
            id: "batch-danger",
            name: "scratch_write",
            input: { name: "batch-danger.js", content: "eval(userInput)" },
          }),
          LLMEvent.toolCall({
            id: "batch-rewrite",
            name: "scratch_write",
            input: { name: "batch-rewrite.txt", content: "original" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        turn({}, "unused")[1]!,
      ]
      yield* session.prompt({ sessionID: batched, prompt: Prompt.make({ text: "write all three" }), resume: false })
      yield* session.resume(batched)

      expect(maxActive).toBe(3)
      // The filesystem is the witness for all three decisions at once.
      expect(fs.readFileSync(path.join(scratch, "batch-safe.txt"), "utf8")).toBe("safe")
      expect(fs.existsSync(path.join(scratch, "batch-danger.js"))).toBe(false)
      expect(fs.readFileSync(path.join(scratch, "batch-rewrite.txt"), "utf8")).toBe("replaced")
      // Transcript order is the model's call order, not the order the fibers happened to finish.
      expect(yield* session.context(batched)).toMatchObject([
        { type: "user", text: "write all three" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "batch-safe",
              state: {
                status: "completed",
                content: [{ text: "wrote 4 bytes" }, { text: "Batou: checked batch-safe" }],
              },
            },
            {
              type: "tool",
              id: "batch-danger",
              state: { status: "error", error: { message: "Batou blocked this write: unsafe eval" } },
            },
            {
              type: "tool",
              id: "batch-rewrite",
              state: {
                status: "completed",
                content: [{ text: "wrote 8 bytes" }, { text: "Batou: checked batch-rewrite" }],
              },
            },
          ],
        },
        { type: "assistant", content: [{ type: "text", text: "Done" }] },
      ])
      // Every call in the batch reached `after` exactly once, denial included.
      expect(seen.map((event) => ({ callID: event.callID, denied: event.denied })).sort(byCallID)).toEqual([
        { callID: "batch-danger", denied: true },
        { callID: "batch-rewrite", denied: false },
        { callID: "batch-safe", denied: false },
      ])
    }),
  )
})

const byCallID = (left: { readonly callID: string }, right: { readonly callID: string }) =>
  left.callID < right.callID ? -1 : left.callID > right.callID ? 1 : 0

process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }))
