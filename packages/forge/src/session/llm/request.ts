import { PermissionV1 } from "@turenlabs/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@turenlabs/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { Effect, Record, Schema } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import { SessionID } from "../schema"

const USER_AGENT = `forge/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly constraints?: RequestConstraints
}

export type RequestConstraints = {
  readonly audit?: {
    readonly record: (receipt: SharedHookReceipt) => void
  }
  readonly messages?: {
    readonly guard: (input: {
      readonly original: readonly ModelMessage[]
      readonly transformed: readonly ModelMessage[]
    }) => ModelMessage[]
  }
  readonly requiredSystem?: readonly string[]
  readonly parameters?: {
    readonly temperature?: { readonly minimum: number; readonly maximum: number }
    readonly topP?: { readonly minimum: number; readonly maximum: number }
    readonly topK?: { readonly minimum: number; readonly maximum: number }
    readonly maxOutputTokens?: number
  }
  readonly providerOptions?: {
    readonly allowed: readonly string[]
    readonly required?: Readonly<Record<string, unknown>>
  }
  readonly exactToolNames?: readonly string[]
  readonly headers?: {
    readonly allowed: readonly string[]
    readonly maxCount: number
    readonly maxNameBytes: number
    readonly maxValueBytes: number
    readonly maxTotalBytes: number
  }
}

export type SharedHookReceipt = {
  readonly version: 1
  readonly pipeline: "forge-shared-llm"
  readonly model: {
    readonly providerID: string
    readonly id: string
  }
  readonly agent: string
  readonly providerTurns: number
  readonly hooks: {
    readonly "experimental.chat.system.transform": number
    readonly "experimental.chat.messages.transform": number
    readonly "chat.params": number
    readonly "chat.headers": number
  }
  readonly sealed: true
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  if (input.constraints?.audit && !input.constraints.messages)
    throw new Error("Shared hook auditing requires the normalized message hook")
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const hookedMessages = input.constraints?.messages
    ? yield* transformNormalizedMessages({
        plugin: input.plugin,
        sessionID: input.sessionID,
        model: input.model,
        messages: input.messages,
        guard: input.constraints.messages.guard,
      })
    : input.messages
  const hookedParams = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers: hookedHeaders } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const constrained = constrainRequest({
    constraints: input.constraints,
    system,
    params: hookedParams,
    tools,
    headers: {
      "x-session-affinity": input.sessionID,
      "X-Session-Id": input.sessionID,
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      "User-Agent": USER_AGENT,
      ...input.model.headers,
      ...hookedHeaders,
    },
  })
  if (isOpenaiOauth) constrained.params.options.instructions = constrained.system.join("\n")
  const messages =
    isOpenaiOauth || input.isWorkflow
      ? hookedMessages
      : [
          ...constrained.system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...hookedMessages,
        ]

  input.constraints?.audit?.record({
    version: 1,
    pipeline: "forge-shared-llm",
    model: {
      providerID: input.model.providerID,
      id: input.model.id,
    },
    agent: input.agent.name,
    providerTurns: 1,
    hooks: {
      "experimental.chat.system.transform": 1,
      "experimental.chat.messages.transform": 1,
      "chat.params": 1,
      "chat.headers": 1,
    },
    sealed: true,
  })

  return {
    system: constrained.system,
    messages,
    tools: Object.fromEntries(Object.entries(constrained.tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params: constrained.params,
    messageTransformOptions: input.constraints ? constrained.params.options : options,
    headers: constrained.headers,
  }
})

export function transformNormalizedMessages(input: {
  readonly plugin: Plugin.Interface
  readonly sessionID: string
  readonly model: Provider.Model
  readonly messages: readonly ModelMessage[]
  readonly guard: NonNullable<RequestConstraints["messages"]>["guard"]
}) {
  return Effect.gen(function* () {
    const roles = new Map(
      input.messages.map((message, index) => [
        SessionV1.MessageID.make(`msg_llm_hook_${index}`),
        { role: message.role, stringContent: typeof message.content === "string" },
      ]),
    )
    const messages = input.messages.map((message, index) =>
      toHookMessage(message, index, SessionID.make(input.sessionID), input.model),
    )
    yield* input.plugin.trigger("experimental.chat.messages.transform", {}, { messages })
    const canonical = Schema.decodeUnknownSync(Schema.Array(SessionV1.WithParts))(messages)
    const transformed = canonical.map((message) => {
      const original = roles.get(message.info.id)
      if (!original) throw new Error("Normalized message hook added or replaced a message identity")
      const expected = original.role === "user" || original.role === "system" ? "user" : "assistant"
      if (message.info.role !== expected) throw new Error("Normalized message hook changed a message role")
      if (message.parts.some((part) => part.messageID !== message.info.id || part.sessionID !== message.info.sessionID))
        throw new Error("Normalized message hook crossed a message boundary")
      return fromHookMessage(message, original.role, original.stringContent)
    })
    return input.guard({ original: input.messages, transformed })
  })
}

function toHookMessage(message: ModelMessage, index: number, sessionID: SessionID, model: Provider.Model) {
  const id = SessionV1.MessageID.make(`msg_llm_hook_${index}`)
  const parts = normalizedParts(message).map((part, partIndex): SessionV1.Part => {
    const base = {
      id: SessionV1.PartID.make(`prt_llm_hook_${index}_${partIndex}`),
      sessionID,
      messageID: id,
    }
    if (part.type === "text") return { ...base, type: "text", text: part.text }
    if (part.type === "reasoning") return { ...base, type: "reasoning", text: part.text, time: { start: 0, end: 0 } }
    if (part.type === "tool-call")
      return {
        ...base,
        type: "tool",
        callID: part.toolCallId,
        tool: part.toolName,
        state: { status: "pending", input: objectInput(part.input), raw: JSON.stringify(part.input) },
      }
    return {
      ...base,
      type: "tool",
      callID: part.toolCallId,
      tool: part.toolName,
      state: {
        status: "completed",
        input: objectInput(part.input),
        output: JSON.stringify(part.output),
        title: part.toolName,
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }
  })
  if (message.role === "user" || message.role === "system")
    return {
      info: {
        id,
        sessionID,
        role: "user" as const,
        time: { created: 0 },
        agent: "normalized-message-hook",
        model: { providerID: model.providerID, modelID: model.id },
      },
      parts,
    }
  return {
    info: {
      id,
      sessionID,
      role: "assistant" as const,
      time: { created: 0, completed: 0 },
      parentID: SessionV1.MessageID.make("msg_llm_hook_parent"),
      modelID: model.id,
      providerID: model.providerID,
      mode: "normalized-message-hook",
      agent: "normalized-message-hook",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

type NormalizedPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  | {
      readonly type: "tool-result"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
      readonly output: unknown
    }

function normalizedParts(message: ModelMessage): NormalizedPart[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }]
  if (!Array.isArray(message.content)) throw new Error("Normalized message hook received unsupported content")
  return message.content.map((value) => {
    if (!value || typeof value !== "object" || !("type" in value))
      throw new Error("Normalized message hook received an invalid content part")
    const part = value as globalThis.Record<string, unknown>
    if (part.type === "text" && typeof part.text === "string") return { type: "text" as const, text: part.text }
    if (part.type === "reasoning" && typeof part.text === "string")
      return { type: "reasoning" as const, text: part.text }
    if (part.type === "tool-call" && typeof part.toolCallId === "string" && typeof part.toolName === "string")
      return {
        type: "tool-call" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      }
    if (part.type === "tool-result" && typeof part.toolCallId === "string" && typeof part.toolName === "string")
      return {
        type: "tool-result" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        output: part.output,
      }
    throw new Error("Normalized message hook received an unsupported content part")
  })
}

function fromHookMessage(
  message: Schema.Schema.Type<typeof SessionV1.WithParts>,
  role: ModelMessage["role"],
  stringContent: boolean,
): ModelMessage {
  const content = message.parts.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text }
    if (part.type === "reasoning") return { type: "reasoning" as const, text: part.text }
    if (part.type !== "tool") throw new Error("Normalized message hook introduced an unsupported part")
    if (role === "tool" && part.state.status === "completed")
      return {
        type: "tool-result" as const,
        toolCallId: part.callID,
        toolName: part.tool,
        input: part.state.input,
        output: parseHookOutput(part.state.output),
      }
    if (role === "assistant" && (part.state.status === "pending" || part.state.status === "running"))
      return {
        type: "tool-call" as const,
        toolCallId: part.callID,
        toolName: part.tool,
        input: part.state.input,
      }
    throw new Error("Normalized message hook changed a tool-call lifecycle state")
  })
  if (stringContent) {
    if (content.some((part) => part.type !== "text"))
      throw new Error("Normalized message hook changed string content into structured content")
    return { role, content: content.map((part) => part.text).join("") } as ModelMessage
  }
  return { role, content } as ModelMessage
}

function objectInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as globalThis.Record<string, unknown>
}

function parseHookOutput(value: string) {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  return decoded._tag === "Some" ? decoded.value : { type: "text", value }
}

export function constrainRequest(input: {
  readonly constraints?: RequestConstraints
  readonly system: readonly string[]
  readonly params: Prepared["params"]
  readonly tools: Record<string, Tool>
  readonly headers: Record<string, string>
}) {
  if (!input.constraints)
    return {
      system: [...input.system],
      params: input.params,
      tools: input.tools,
      headers: input.headers,
    }
  const parameters = input.constraints.parameters
  const options = input.constraints.providerOptions
    ? {
        ...Object.fromEntries(
          Object.entries(input.params.options).filter(([key]) =>
            input.constraints!.providerOptions!.allowed.includes(key),
          ),
        ),
        ...(input.constraints.providerOptions.required ?? {}),
      }
    : input.params.options
  const tools = Object.keys(input.tools).toSorted()
  const requiredTools = input.constraints.exactToolNames?.toSorted()
  if (requiredTools && JSON.stringify(tools) !== JSON.stringify(requiredTools))
    throw new Error("Constrained LLM request active tools do not match the admitted tool set")
  return {
    system: [...input.system, ...(input.constraints.requiredSystem ?? [])],
    params: {
      temperature: clamp(input.params.temperature, parameters?.temperature),
      topP: clamp(input.params.topP, parameters?.topP),
      topK: clamp(input.params.topK, parameters?.topK),
      maxOutputTokens:
        parameters?.maxOutputTokens === undefined
          ? input.params.maxOutputTokens
          : Math.min(input.params.maxOutputTokens ?? parameters.maxOutputTokens, parameters.maxOutputTokens),
      options,
    },
    tools: input.tools,
    headers: constrainHeaders(input.headers, input.constraints.headers),
  }
}

function clamp(value: number | undefined, range: { readonly minimum: number; readonly maximum: number } | undefined) {
  if (!range) return value
  if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) || range.minimum > range.maximum)
    throw new Error("Invalid constrained LLM parameter range")
  if (value === undefined || !Number.isFinite(value)) return range.minimum
  return Math.max(range.minimum, Math.min(range.maximum, value))
}

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function constrainHeaders(headers: Record<string, string>, constraints: RequestConstraints["headers"]) {
  if (!constraints) return headers
  const encoder = new TextEncoder()
  const allowed = new Set(constraints.allowed.map((name) => name.toLowerCase()))
  const seen = new Set<string>()
  const entries = Object.entries(headers)
  if (entries.length > constraints.maxCount) throw new Error("Constrained LLM request has too many headers")
  const total = entries.reduce((bytes, [name, value]) => {
    const normalized = name.toLowerCase()
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/i.test(name) || /[\r\n]/.test(value))
      throw new Error("Constrained LLM request contains an invalid header")
    if (FORBIDDEN_HEADERS.has(normalized) || !allowed.has(normalized))
      throw new Error(`Constrained LLM request rejected header: ${name}`)
    if (seen.has(normalized)) throw new Error(`Constrained LLM request has duplicate header: ${name}`)
    seen.add(normalized)
    const nameBytes = encoder.encode(name).byteLength
    const valueBytes = encoder.encode(value).byteLength
    if (nameBytes > constraints.maxNameBytes || valueBytes > constraints.maxValueBytes)
      throw new Error("Constrained LLM request header exceeds its byte limit")
    return bytes + nameBytes + valueBytes
  }, 0)
  if (total > constraints.maxTotalBytes) throw new Error("Constrained LLM request headers exceed their byte limit")
  return Object.fromEntries(entries)
}

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
