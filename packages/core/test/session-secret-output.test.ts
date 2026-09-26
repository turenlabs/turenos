import { describe, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@turenlabs/llm"
import { OpenAIChat } from "@turenlabs/llm/protocols/openai-chat"
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
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionRunCoordinator } from "@turenlabs/core/session/run-coordinator"
import { SessionRunner } from "@turenlabs/core/session/runner"
import { node } from "@turenlabs/core/session/runner/llm"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionTable, SessionMessageTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { Snapshot } from "@turenlabs/core/snapshot"
import { SystemContext } from "@turenlabs/core/system-context"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { SessionDisclosure } from "@turenlabs/core/session/disclosure"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

import { eq } from "drizzle-orm"
import { EventTable } from "@turenlabs/core/event/sql"
import { ToolExecutionTable } from "@turenlabs/core/tool/execution.sql"

const scratch = mkdtempSync(join(tmpdir(), "forge-session-secret-"))
let responses: LLMEvent[][] = []
const requests: LLMRequest[] = []
// Stands in for the Claude Code CLI calling TurenOS tools over the turn's private MCP bridge.
type BridgeCall = { readonly name: string; readonly arguments: Record<string, unknown> }
const bridgeCalls: BridgeCall[] = []
const bridgeResults: unknown[] = []
// An MCP client connected to the turn's bridge with its bearer credential, closed with the scope.
const connect = (token: string) =>
  Effect.gen(function* () {
    const server = yield* ClaudeCodeMcp.serve(token)
    const mcp = new Client({ name: "forge-secret-test", version: "1" })
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: server.authorization } },
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => mcp.connect(transport)),
      () => Effect.promise(() => mcp.close()),
    )
    return mcp
  })
// A rejected call is recorded rather than thrown, so its text can be checked for leaks.
const call = (mcp: Client, input: BridgeCall) =>
  Effect.promise(() => mcp.callTool(input).catch((error: unknown) => ({ rejected: String(error) })))
const callBridge = (token: string) =>
  Effect.gen(function* () {
    const mcp = yield* connect(token)
    for (const input of bridgeCalls.splice(0)) bridgeResults.push(yield* call(mcp, input))
  }).pipe(Effect.scoped)
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const events = Stream.fromIterable(responses.shift() ?? [])
      const token = ClaudeCodeMcp.requestToken(request.metadata)
      if (!token || bridgeCalls.length === 0) return events
      return Stream.unwrap(callBridge(token).pipe(Effect.orDie, Effect.as(events)))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const modelsFor = (providerID: ProviderV2.ID) =>
  SessionRunnerModel.layerWith(() =>
    Effect.succeed({ model, ref: ModelV2.Ref.make({ id: ModelV2.ID.make(model.id), providerID }), cost: [] }),
  )
const models = modelsFor(ProviderV2.ID.make(model.provider))
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

// The source file retains the synthetic token; only tool output may be masked.
const secret = `ghp_${"aB12".repeat(9)}`
const gitlab = `glpat-${"Zx9-".repeat(5)}`
// A configured value whose first half is also a detected format (see the composite regressions).
const composite = `AKIA${"Q7".repeat(8)}:synthetic/Private+Suffix92837`
const fixture = join(scratch, "credential.txt")
const fileRead = Tool.make({
  description: "Read the synthetic credential fixture",
  input: Schema.Struct({}),
  output: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.promise(async () => ({ text: await Bun.file(fixture).text() })),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
})
const toolsLayer = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      fixture_read: fileRead,
      // Defects and interruptions settle the registry call as a failure, not a tool error result.
      // GitLab tokens are outside ToolVisibleError's own heuristics, so only the guard can mask it.
      fixture_crash: Tool.make({
        description: "Crash with a synthetic credential in the defect",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.die(new Error(`adapter crashed while holding ${gitlab}`)),
      }),
      fixture_interrupt: Tool.make({
        description: "Interrupt itself",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.interrupt,
      }),
      fixture_composite: Tool.make({
        description: "Crash with a configured composite credential in the defect",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.die(new Error(`adapter crashed while holding ${composite}`)),
      }),
    }),
  ),
)
const toolsNode = makeLocationNode({
  name: "test/session-secret-tools",
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
const harness = (extra: ReadonlyArray<readonly [unknown, unknown]> = []) => {
  const selected = [...replacements.filter(([target]) => !extra.some(([other]) => other === target)), ...extra]
  const runnerLayer = AppNodeBuilder.build(node, selected as never)
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
  return testEffect(
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
        ExtensionRuntime.node,
        node,
        SessionV2.node,
      ]),
      [...selected, [SessionExecution.node, execution]] as never,
    ),
  )
}
const endToEnd = harness()
// Format detectors only, with an outage switch: exercises the runner's handling of an unavailable
// credential snapshot without touching real credential storage.
const protection = { available: true }
const guarded = harness([
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
])
const cli = harness([[SessionRunnerModel.node, modelsFor(ClaudeCodeCLI.ID)]])

const turn = (input: unknown, id: string) => [
  [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id, name: "fixture_read", input }),
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

describe("Session secret-safe tool output", () => {
  for (const overflow of [false, true]) {
    endToEnd.effect(
      `masks file read output in the next provider request and durable storage (overflow=${overflow})`,
      () =>
        Effect.gen(function* () {
          const id = SessionV2.ID.make(`ses_secret_e2e_${overflow ? "overflow" : "small"}`)
          yield* prepare(id)
          const source = `credential=${secret}\n${overflow ? "ordinary line\n".repeat(8000) : "ordinary line\n"}`
          yield* Effect.promise(() => Bun.write(fixture, source))
          responses = turn({}, "read-credential")
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Read the fixture" }), resume: false })
          yield* session.resume(id)

          expect(requests).toHaveLength(2)
          const providerBody = yield* OpenAIChat.protocol.body.from(requests[1]!)
          const nextRequest = JSON.stringify(providerBody)
          expect(nextRequest.includes(secret)).toBe(false)
          expect(nextRequest).toMatch(/\[SECRET:v1:github:[a-f0-9]{32}\]/)
          // Check provider-native tool content, rather than merely a system warning.
          const toolMessages = providerBody.messages.filter((message) => message.role === "tool")
          expect(toolMessages).toHaveLength(1)
          const placeholder = JSON.stringify(toolMessages).match(/\[SECRET:v1:github:[a-f0-9]{32}\]/)?.[0]
          expect(placeholder).toBeDefined()

          const database = yield* Database.Service
          const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()
          const projected = yield* database.db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, id))
            .all()
          const executions = yield* database.db
            .select()
            .from(ToolExecutionTable)
            .where(eq(ToolExecutionTable.session_id, id))
            .all()
          expect(events.length).toBeGreaterThan(0)
          expect(projected).toHaveLength(3)
          expect(executions).toHaveLength(1)
          expect(executions[0]!.status).toBe("completed")
          const context = yield* session.context(id)
          for (const retained of [events, projected, executions, context]) {
            expect(JSON.stringify(retained).includes(secret)).toBe(false)
            expect(JSON.stringify(retained)).toContain(placeholder!)
          }

          const outputPaths = executions[0]!.settlement?.outputPaths ?? []
          expect(outputPaths).toHaveLength(overflow ? 1 : 0)
          for (const outputPath of outputPaths) {
            const retained = yield* Effect.promise(() => Bun.file(outputPath).text())
            expect(retained.includes(secret)).toBe(false)
            expect(retained).toContain(placeholder!)
            expect(retained).toContain("ordinary line")
          }
          expect(yield* Effect.promise(() => Bun.file(fixture).text())).toBe(source)
        }),
    )
  }

  guarded.effect("an unavailable protection snapshot fails the turn visibly before any provider request", () =>
    Effect.gen(function* () {
      const id = SessionV2.ID.make("ses_secret_unavailable")
      yield* prepare(id)
      responses = turn({}, "never-read")
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Read the fixture" }), resume: false })
      protection.available = false
      yield* session.resume(id).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => (protection.available = true))))
      expect(requests).toHaveLength(0)
      const database = yield* Database.Service
      const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()
      const failed = events.filter((event) => event.type.startsWith("session.next.step.failed"))
      expect(failed).toHaveLength(1)
      expect(JSON.stringify(failed[0]?.data)).toContain("Secret output protection unavailable")
    }),
  )

  guarded.effect("a legacy history record the guard cannot process no longer poisons later turns", () =>
    Effect.gen(function* () {
      const id = SessionV2.ID.make("ses_secret_legacy")
      yield* prepare(id)
      yield* Effect.promise(() => Bun.write(fixture, "credential=synthetic-placeholder\n"))
      responses = turn({}, "legacy-read")
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Read the fixture" }), resume: false })
      yield* session.resume(id)
      expect(requests).toHaveLength(2)
      // Store the tool result the way an older build could have: raw, and deeper than the guard walks.
      const database = yield* Database.Service
      const rows = yield* database.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, id))
        .all()
      const assistant = rows.find((row) => row.type === "assistant" && JSON.stringify(row.data).includes('"tool"'))
      expect(assistant).toBeDefined()
      const nest = (depth: number): Record<string, unknown> =>
        depth === 0 ? { token: secret } : { child: nest(depth - 1) }
      const deep = nest(70)
      const data = structuredClone(assistant!.data) as unknown as { content: Array<Record<string, unknown>> }
      for (const part of data.content)
        if (part.type === "tool")
          part.state = { ...(part.state as Record<string, unknown>), structured: deep, content: [] }
      yield* database.db
        .update(SessionMessageTable)
        .set({ data: data as never })
        .where(eq(SessionMessageTable.id, assistant!.id))
        .run()
        .pipe(Effect.orDie)

      requests.length = 0
      responses = turn({}, "unused").slice(1)
      yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(id)
      expect(requests).toHaveLength(1)
      const body = JSON.stringify(yield* OpenAIChat.protocol.body.from(requests[0]!))
      expect(body).not.toContain(secret)
      expect(body).toContain(SessionDisclosure.WITHHELD)
      expect(body).toContain("Continue")
      const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()
      expect(events.some((event) => event.type.startsWith("session.next.step.failed"))).toBe(false)
    }),
  )

  cli.effect("CLI bridge failures return a redacted diagnostic and always settle the durable call", () =>
    Effect.gen(function* () {
      const id = SessionV2.ID.make("ses_secret_cli_bridge")
      yield* prepare(id)
      bridgeResults.length = 0
      bridgeCalls.push({ name: "fixture_crash", arguments: {} }, { name: "fixture_interrupt", arguments: {} })
      responses = turn({}, "unused").slice(1)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Use the tools" }), resume: false })
      yield* session.resume(id)

      const database = yield* Database.Service
      const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()
      expect(JSON.stringify(events)).not.toContain(gitlab)
      const called = events.filter((event) => event.type.startsWith("session.next.tool.called"))
      const settled = events.filter(
        (event) =>
          event.type.startsWith("session.next.tool.failed") || event.type.startsWith("session.next.tool.success"),
      )
      expect(called).toHaveLength(2)
      expect(settled).toHaveLength(2)

      expect(bridgeResults).toHaveLength(2)
      const [crash, interrupted] = bridgeResults.map((result) => JSON.stringify(result))
      expect(crash).not.toContain(gitlab)
      expect(crash).toContain("adapter crashed")
      expect(crash).toContain("[SECRET:v1:gitlab:")
      expect(interrupted).toContain("interrupted")
    }),
  )

  const configureComposite = Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    yield* extensions.update(
      Extension.ID.make("turenlabs", "pagerduty"),
      { enabled: false, secrets: { PAGERDUTY_CLIENT_SECRET: composite } },
      { local: true },
    )
  })
  const retained = (id: SessionV2.ID) =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()
      const executions = yield* database.db
        .select()
        .from(ToolExecutionTable)
        .where(eq(ToolExecutionTable.session_id, id))
        .all()
      return { events, executions }
    })

  cli.effect("CLI bridge failures mask a whole configured value before legacy error formatting", () =>
    Effect.gen(function* () {
      const id = SessionV2.ID.make("ses_secret_cli_composite")
      yield* prepare(id)
      yield* configureComposite
      bridgeResults.length = 0
      bridgeCalls.push({ name: "fixture_composite", arguments: {} })
      responses = turn({}, "unused").slice(1)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Use the tool" }), resume: false })
      yield* session.resume(id)

      expect(bridgeResults).toHaveLength(1)
      const { events, executions } = yield* retained(id)
      for (const record of [bridgeResults, events, executions].map((value) => JSON.stringify(value))) {
        expect(record).not.toContain("Private+Suffix92837")
        expect(record).not.toContain("AKIA")
      }
      expect(JSON.stringify(bridgeResults)).toMatch(/adapter crashed while holding \[SECRET:v1:known:[a-f0-9]{32}\]/)
      expect(events.some((event) => event.type.startsWith("session.next.tool.failed"))).toBe(true)
    }),
  )

  endToEnd.effect("native tool failures mask a whole configured value before legacy error formatting", () =>
    Effect.gen(function* () {
      const id = SessionV2.ID.make("ses_secret_native_composite")
      yield* prepare(id)
      yield* configureComposite
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "composite-call", name: "fixture_composite", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        ...turn({}, "unused").slice(1),
      ]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Use the tool" }), resume: false })
      yield* session.resume(id).pipe(Effect.exit)

      const { events, executions } = yield* retained(id)
      const failed = events.filter((event) => event.type.startsWith("session.next.tool.failed"))
      expect(failed).toHaveLength(1)
      for (const record of [events, executions].map((value) => JSON.stringify(value))) {
        expect(record).not.toContain("Private+Suffix92837")
        expect(record).not.toContain("AKIA")
      }
      expect(JSON.stringify(failed)).toMatch(/adapter crashed while holding \[SECRET:v1:known:[a-f0-9]{32}\]/)
    }),
  )
})

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }))
