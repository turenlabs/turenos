import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { LLM, type Model } from "@turenlabs/llm"
import { AnthropicMessages } from "@turenlabs/llm/protocols/anthropic-messages"
import { BedrockConverse } from "@turenlabs/llm/protocols/bedrock-converse"
import { Gemini } from "@turenlabs/llm/protocols/gemini"
import { OpenAIChat } from "@turenlabs/llm/protocols/openai-chat"
import { OpenAIResponses } from "@turenlabs/llm/protocols/openai-responses"
import { LLMClient } from "@turenlabs/llm/route"
import { AgentV2 } from "@turenlabs/core/agent"
import { AgentGuidance } from "@turenlabs/core/agent/guidance"
import { Config } from "@turenlabs/core/config"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AgentPlugin } from "@turenlabs/core/plugin/agent"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionExecutionControl } from "@turenlabs/core/session/execution-control"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SystemContext } from "@turenlabs/core/system-context"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { Tool } from "@turenlabs/core/tool/tool"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const currentLocation = Location.Service.of(location({ directory: AbsolutePath.make("/project") }))
let listedTasks: ReadonlyArray<SessionTaskV2.Info> = []
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AgentV2.node, AgentGuidance.node, FSUtil.node, SubagentTool.node]), [
    // Stubbed so the projection is not read from whatever config the machine
    // running this suite happens to have on disk.
    [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
    [Location.node, Layer.succeed(Location.Service, currentLocation)],
    [LocationMutation.node, Layer.mock(LocationMutation.Service, {})],
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
    [
      SessionTaskV2.node,
      Layer.mock(SessionTaskV2.Service, {
        authority: () => Effect.succeed(undefined),
        hasChildren: (parentSessionID) =>
          Effect.sync(() => listedTasks.some((task) => task.parentSessionID === parentSessionID)),
        list: () => Effect.sync(() => listedTasks),
        // Mirrors the durable query's contract: every active child first, then
        // the newest terminal ones up to the limit, returned in creation order
        // and flagged when anything was left out.
        listDirectBounded: (parentSessionID, limit) =>
          Effect.sync(() => {
            const children = listedTasks.filter((task) => task.parentSessionID === parentSessionID)
            const maximum = Math.max(1, Math.trunc(limit))
            const isActive = (task: SessionTaskV2.Info) => task.status === "starting" || task.status === "running"
            const active = children.filter(isActive)
            const remaining = maximum - Math.min(active.length, maximum)
            const terminal = children.filter((task) => !isActive(task))
            const kept = new Set(
              [...active.slice(0, maximum), ...terminal.slice(Math.max(0, terminal.length - remaining))].map(
                (task) => task.id,
              ),
            )
            return {
              tasks: children.filter((task) => kept.has(task.id)),
              truncated: kept.size < children.length,
            }
          }),
        owner: () => Effect.succeed(undefined),
      }),
    ],
  ]),
)

const ProjectedSchema = Schema.Struct({
  properties: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  required: Schema.Array(Schema.String).pipe(Schema.optional),
})
const decodeProjectedSchema = Schema.decodeUnknownSync(ProjectedSchema)

const expectedShapes = {
  spawn_agent: {
    properties: ["agent", "commands", "description", "model", "prompt", "write_roots"],
    required: ["agent", "description", "prompt"],
  },
  send_agent: {
    properties: ["prompt", "task_id"],
    required: ["prompt", "task_id"],
  },
  wait_agents: {
    properties: ["task_ids", "timeout_ms"],
    required: ["task_ids"],
  },
  interrupt_agent: {
    properties: ["task_id"],
    required: ["task_id"],
  },
  list_agents: {
    properties: [],
    required: [],
  },
  peek_agent: {
    properties: ["limit", "task_id"],
    required: ["task_id"],
  },
  agent_doc: {
    properties: ["agent"],
    required: [],
  },
  propose_agent_improvement: {
    properties: ["agent", "evidence", "proposal", "rationale"],
    required: ["agent", "evidence", "proposal", "rationale"],
  },
  adjudicate_agent_improvement: {
    properties: ["pass", "proposal_id", "validation"],
    required: ["pass", "proposal_id", "validation"],
  },
  apply_agent_improvement: {
    properties: ["proposal_id"],
    required: ["proposal_id"],
  },
  board_post: {
    properties: ["body", "evidence", "kind", "supersedes", "title"],
    required: ["body", "kind", "title"],
  },
  board_read: {
    properties: ["cursor", "include_superseded", "kind"],
    required: [],
  },
}

const catalogModel = (providerID: string, packageName: string, url: string, apiID = "test-model") =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(apiID),
    providerID: ProviderV2.ID.make(providerID),
    name: `${providerID} model`,
    api: {
      id: ModelV2.ID.make(apiID),
      type: "aisdk",
      package: packageName,
      url,
    },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { apiKey: "test-key" } },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 16_000 },
  })

const listedTask = (index: number, status: SessionTaskV2.Status) =>
  SessionTaskV2.Info.make({
    id: SessionTaskV2.ID.make(`tsk_provider_projection_${index.toString().padStart(2, "0")}`),
    rootSessionID: SessionSchema.ID.make("ses_provider_projection"),
    parentSessionID: SessionSchema.ID.make("ses_provider_projection"),
    childSessionID: SessionSchema.ID.make(`ses_provider_projection_child_${index.toString().padStart(2, "0")}`),
    actor: SessionTaskV2.Actor.make({
      sessionID: SessionSchema.ID.make("ses_provider_projection"),
      assistantMessageID: SessionMessage.ID.make(`msg_provider_projection_${index.toString().padStart(2, "0")}`),
      toolCallID: `call-provider-projection-${index}`,
    }),
    agent: AgentV2.ID.make("explore"),
    prompt: Prompt.make({ text: "Inspect the bounded output." }),
    description: `Projection task ${index}`,
    depth: 1,
    status,
    revision: 1,
    authority: SessionTaskV2.Authority.make({
      parentPermissions: [],
      ancestorPermissionSets: [],
      childPermissions: [],
      hardPermissions: [],
      writeRoots: [],
      commands: [],
    }),
    result: "r".repeat(5_000),
    error: `token=task-secret /Users/private/work ${"e".repeat(5_000)}`,
    time: {
      created: DateTime.makeUnsafe(index),
      updated: DateTime.makeUnsafe(index),
      completed: status === "completed" ? DateTime.makeUnsafe(index) : undefined,
    },
  })

const normalize = (tools: ReadonlyArray<{ readonly name: string; readonly schema: unknown }>) =>
  Object.fromEntries(
    tools.map((tool) => {
      // Gemini's dialect has no way to spell an empty parameter object -- Google rejects
      // `{"type":"OBJECT","properties":{}}` -- so a parameterless tool omits `parameters`
      // entirely. That is the same contract every other adapter spells as an empty object,
      // so normalise the omission rather than exempting the adapter.
      const schema = decodeProjectedSchema(tool.schema ?? {})
      return [
        tool.name,
        {
          properties: Object.keys(schema.properties ?? {}).toSorted(),
          required: [...(schema.required ?? [])].toSorted(),
        },
      ]
    }),
  )

describe("subagent provider projection", () => {
  it.effect("projects the actual durable subagent tools and guidance through every V2 model adapter", () =>
    Effect.gen(function* () {
      listedTasks = []
      const agents = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Location.Service, currentLocation),
      )
      const guidance = yield* AgentGuidance.Service
      const system = (yield* SystemContext.initialize(yield* guidance.load(yield* agents.select()))).baseline
      const subagents = yield* SubagentTool.Service
      const definitions = Object.entries(
        yield* subagents.forExecution({
          sessionID: SessionSchema.ID.make("ses_provider_projection"),
          control: SessionExecutionControl.noop,
          model: ModelV2.Ref.make({
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model"),
          }),
        }),
      ).map(([name, tool]) => Tool.definition(name, tool))
      expect(definitions.every((definition) => definition.inputSchema.type === "object")).toBe(true)
      const request = (model: Model) => LLM.request({ model, system, prompt: "Delegate the work.", tools: definitions })
      const openai = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("openai", "@ai-sdk/openai", "https://openai.example/v1"),
      )
      const anthropic = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("anthropic", "@ai-sdk/anthropic", "https://anthropic.example/v1"),
      )
      const google = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("google", "@ai-sdk/google", "https://google.example/v1"),
      )
      const compatible = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("compatible", "@ai-sdk/openai-compatible", "https://compatible.example/v1"),
      )
      const kimi = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("kimi-for-coding", "@ai-sdk/anthropic", "https://api.kimi.com/coding/v1", "k3"),
      )
      const bedrock = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("amazon-bedrock", "@ai-sdk/amazon-bedrock", "https://bedrock.example"),
      )
      const azure = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("azure", "@ai-sdk/azure", "https://azure.example/openai"),
      )
      const openrouter = yield* SessionRunnerModel.fromCatalogModel(
        catalogModel("openrouter", "@openrouter/ai-sdk-provider", "https://openrouter.example/api/v1"),
      )

      const openaiBody = (yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(request(openai))).body
      const anthropicBody = (yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(request(anthropic))).body
      const googleBody = (yield* LLMClient.prepare<Gemini.GeminiBody>(request(google))).body
      const compatibleBody = (yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(request(compatible))).body
      const kimiBody = (yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(request(kimi))).body
      const bedrockBody = (yield* LLMClient.prepare<BedrockConverse.BedrockConverseBody>(request(bedrock))).body
      const azureBody = (yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(request(azure))).body
      const openrouterBody = (yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(request(openrouter))).body

      expect(
        normalize(
          (openaiBody.tools ?? [])
            .filter((tool) => tool.type === "function")
            .map((tool) => ({ name: tool.name, schema: tool.parameters })),
        ),
      ).toEqual(expectedShapes)
      expect(
        normalize((anthropicBody.tools ?? []).map((tool) => ({ name: tool.name, schema: tool.input_schema }))),
      ).toEqual(expectedShapes)
      expect(
        normalize(
          (googleBody.tools ?? []).flatMap((tool) =>
            tool.functionDeclarations.map((item) => ({ name: item.name, schema: item.parameters })),
          ),
        ),
      ).toEqual(expectedShapes)
      expect(
        normalize(
          (compatibleBody.tools ?? []).map((tool) => ({
            name: tool.function.name,
            schema: tool.function.parameters,
          })),
        ),
      ).toEqual(expectedShapes)
      expect(normalize((kimiBody.tools ?? []).map((tool) => ({ name: tool.name, schema: tool.input_schema })))).toEqual(
        expectedShapes,
      )
      expect(
        normalize(
          (bedrockBody.toolConfig?.tools ?? [])
            .filter((tool) => "toolSpec" in tool)
            .map((tool) => ({ name: tool.toolSpec.name, schema: tool.toolSpec.inputSchema.json })),
        ),
      ).toEqual(expectedShapes)
      expect(
        normalize(
          (azureBody.tools ?? [])
            .filter((tool) => tool.type === "function")
            .map((tool) => ({ name: tool.name, schema: tool.parameters })),
        ),
      ).toEqual(expectedShapes)
      expect(
        normalize(
          (openrouterBody.tools ?? []).map((tool) => ({
            name: tool.function.name,
            schema: tool.function.parameters,
          })),
        ),
      ).toEqual(expectedShapes)

      expect(
        [openaiBody, anthropicBody, googleBody, compatibleBody, kimiBody, bedrockBody, azureBody, openrouterBody].every(
          (body) => JSON.stringify(body).includes("Avoid nested delegation"),
        ),
      ).toBe(true)
      expect(kimi.route.id).toBe("anthropic-messages")
      expect(kimi.route.endpoint.baseURL).toBe("https://api.kimi.com/coding/v1")
      expect(bedrock.route.id).toBe("bedrock-converse")
      expect(azure.route.id).toBe("azure-openai-responses")
      expect(openrouter.route.id).toBe("openrouter")
    }),
  )

  it.effect("bounds list task count and terminal previews before provider projection", () =>
    Effect.gen(function* () {
      listedTasks = Array.from({ length: 40 }, (_, index) => listedTask(index, index === 0 ? "running" : "completed"))
      const agents = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Location.Service, currentLocation),
      )
      const subagents = yield* SubagentTool.Service
      const tools = yield* subagents.forExecution({
        sessionID: SessionSchema.ID.make("ses_provider_projection"),
        control: SessionExecutionControl.noop,
        model: ModelV2.Ref.make({
          providerID: ProviderV2.ID.make("test"),
          id: ModelV2.ID.make("test-model"),
        }),
      })
      const tool = tools[SubagentTool.listName]
      expect(tool).toBeDefined()
      if (!tool) return
      const output = yield* Tool.settle(
        tool,
        { type: "tool-call", id: "call-list", name: SubagentTool.listName, input: {} },
        {
          sessionID: SessionSchema.ID.make("ses_provider_projection"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_provider_projection_list"),
          toolCallID: "call-list",
        },
      )
      const listed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          tasks: Schema.Array(
            Schema.Struct({
              task_id: SessionTaskV2.ID,
              result: Schema.String,
              result_truncated: Schema.Boolean,
              error: Schema.String,
              error_truncated: Schema.Boolean,
            }),
          ),
          truncated: Schema.Boolean,
        }),
      )(output.structured)

      expect(listed.truncated).toBe(true)
      expect(listed.tasks).toHaveLength(32)
      expect(listed.tasks.map((task) => task.task_id)).toContain(SessionTaskV2.ID.make("tsk_provider_projection_00"))
      expect(listed.tasks.map((task) => task.task_id)).not.toContain(
        SessionTaskV2.ID.make("tsk_provider_projection_08"),
      )
      expect(listed.tasks.every((task) => task.result.length <= 4_096 && task.result_truncated)).toBe(true)
      expect(listed.tasks.every((task) => task.result.endsWith("… [result truncated]"))).toBe(true)
      expect(listed.tasks.every((task) => task.error.length <= 4_096 && task.error_truncated)).toBe(true)
      expect(listed.tasks.every((task) => !task.error.includes("task-secret") && !task.error.includes("/Users/"))).toBe(
        true,
      )
    }),
  )
})
