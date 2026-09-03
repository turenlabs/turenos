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

/**
 * Context occupancy is a property of a single request, never a session-wide sum.
 *
 * Every assistant message records the usage of one provider request (transports that run
 * their own loop, like the Claude Code CLI, report their final request here and their run
 * total separately), so the newest one describes the window as it stands now. Adding
 * successive messages together would count cache reads once per round trip — a figure that
 * grows without bound and, being a running total, can never fall when a session is compacted.
 */
const promptTotal = (msg: AssistantMessage) => msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write

const contextTotal = (msg: AssistantMessage) => promptTotal(msg) + msg.tokens.output + msg.tokens.reasoning

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (contextTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = contextTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    prompt: promptTotal(message),
    total,
    // No published context limit means the percentage is unknowable. Say so rather
    // than divide by a guess.
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
