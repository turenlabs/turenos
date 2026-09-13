import { HttpRecorder } from "@turenlabs/http-recorder"
import { HttpRecorderInternal } from "@turenlabs/http-recorder/internal"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { PermissionV2 } from "@turenlabs/core/permission"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { Snapshot } from "@turenlabs/core/snapshot"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionRunCoordinator } from "@turenlabs/core/session/run-coordinator"
import { SessionRunner } from "@turenlabs/core/session/runner"
import * as SessionRunnerLLM from "@turenlabs/core/session/runner/llm"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { Location } from "@turenlabs/core/location"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { SystemContext } from "@turenlabs/core/system-context"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { ReferenceGuidance } from "@turenlabs/core/reference/guidance"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { testEffect } from "./lib/effect"

const cassette =
  process.env.RECORD === "true"
    ? HttpRecorderInternal.cassetteLayer("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
        mode: "record",
      })
    : HttpRecorder.http("session-runner/openai-chat-streams-text", {
      directory: path.resolve(import.meta.dir, "fixtures/recordings"),
      match: (incoming, expected) => {
          if (incoming.method !== expected.method || incoming.url !== expected.url) return false
          if (JSON.stringify(incoming.headers) !== JSON.stringify(expected.headers)) return false
          const body = JSON.parse(incoming.body ?? "{}") as Record<string, unknown>
          const stripDiscoveryContext = (content: string) =>
            content.replace(
              /Additional built-in capabilities —[\s\S]*?The selected tool becomes available on the following model turn within the same user request; use it then to complete the request\.\s*/,
              "",
            )
          const messages = Array.isArray(body.messages)
            ? body.messages.map((message) => {
                if (!message || typeof message !== "object") return message
                const content = (message as { content?: unknown }).content
                if (typeof content === "string") return { ...message, content: stripDiscoveryContext(content).trimEnd() }
                if (!Array.isArray(content)) return message
                return {
                  ...message,
                  content: content.filter(
                    (part) =>
                      !part ||
                      typeof part !== "object" ||
                      typeof (part as { text?: unknown }).text !== "string" ||
                      !(part as { text: string }).text.startsWith("Additional built-in capabilities —"),
                  ).map((part) =>
                    part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                      ? { ...part, text: stripDiscoveryContext((part as { text: string }).text) }
                      : part,
                  ),
                }
              })
            : body.messages
          const normalizedBody = Object.fromEntries(
            Object.entries({ ...body, messages }).filter(([key]) => key !== "tools"),
          )
          const matches =
            JSON.stringify(normalizedBody) ===
            expected.body
          return matches
        },
      })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed({
    model,
    ref: ModelV2.Ref.make({
      id: ModelV2.ID.make(model.id),
      providerID: ProviderV2.ID.make(model.provider),
    }),
    // Transcribed from the live catalog: models.dev has
    // `openai/gpt-4o-mini.cost = {input: 0.15, output: 0.6, cache_read: 0.075}`
    // with no `cache_write` and no tiers, which the models-dev plugin lowers to
    // exactly this one untiered entry.
    cost: [{ input: 0.15, output: 0.6, cache: { read: 0.075, write: 0 } }],
  }),
)
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const directory = AbsolutePath.make(realpathSync(tmpdir()))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
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
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionV2.node,
    ]),
    [
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
      [SessionExecution.node, execution],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded V2 prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory,
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // Pin the agent's own system prompt. Without one the turn would carry the model-family prompt
      // selected in `session/provider-prompt.ts` (`gpt-4o-mini` resolves to `beast.txt`), which would
      // bake eleven kilobytes of prompt text into this cassette and re-break it on every prompt edit.
      // Provider-prompt selection is covered where it belongs, in `session-provider-prompt.test.ts`
      // and the request-assembly tests in `session-runner.test.ts`.
      yield* (yield* AgentV2.Service).transform((draft) =>
        draft.update(AgentV2.defaultID, (agent) => {
          agent.system = "You are a test agent."
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      const prompt = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Say hello in one short sentence." }),
        resume: false,
      })

      yield* session.resume(sessionID)

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "build", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.next.prompt.admitted.1",
        "session.next.prompted.1",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])
      // The recorded response reports prompt_tokens 22 (cached 0), completion 2.
      // At the transcribed gpt-4o-mini rates that is (22 * 0.15 + 2 * 0.6) / 1e6.
      expect(
        yield* db
          .select({
            cost: SessionTable.cost,
            input: SessionTable.tokens_input,
            output: SessionTable.tokens_output,
            reasoning: SessionTable.tokens_reasoning,
            read: SessionTable.tokens_cache_read,
            write: SessionTable.tokens_cache_write,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ cost: 0.0000045, input: 22, output: 2, reasoning: 0, read: 0, write: 0 })
    }),
  )
})
