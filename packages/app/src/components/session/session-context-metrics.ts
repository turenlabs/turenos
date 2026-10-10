import { contextTokens, promptTokens, usagePercent } from "@turenlabs/client/context"
import type { AssistantMessage, Message } from "@turenlabs/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  /** Non-cached input tokens only — the sliver of the prompt the provider billed at full rate. */
  input: number
  /**
   * The whole prompt of the most recent request: non-cached input plus everything served
   * from or written to the prompt cache. Cached tokens still occupy the window; they are
   * only billed differently.
   */
  prompt: number
  /** Context-window occupancy: that prompt plus the response appended to it. */
  total: number
  usage: number | null
}

// Occupancy is one request, never a sum: see @turenlabs/client/context.

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (contextTokens(msg.tokens) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = contextTokens(message.tokens)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    prompt: promptTokens(message.tokens),
    total,
    usage: usagePercent(total, limit),
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
