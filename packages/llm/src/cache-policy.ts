// Apply an `LLMRequest.cache` policy by injecting `CacheHint`s onto the parts
// the policy designates. Runs once at compile time, before the per-protocol
// body builder, so the existing inline-hint lowering path handles the rest.
//
// The default `"auto"` shape places one breakpoint at the last tool definition,
// one at the last system part, one at the latest user message, and one at
// the latest durable message. The user boundary anchors the prefix while
// the rolling boundary also caches the tool results accumulated during a turn.
//
// Manual `cache: CacheHint` placements on individual parts are preserved —
// this function only fills gaps the caller left empty.
import { CacheHint, type CachePolicy, type CachePolicyObject } from "./schema/options"
import { LLMRequest, Message, ToolDefinition, type ContentPart } from "./schema/messages"

const AUTO: CachePolicyObject = {
  tools: true,
  system: true,
  messages: "latest-user-message",
}

const NONE: CachePolicyObject = {}

// Resolution rules:
//   - undefined   → "auto" — caching is on by default. The math favors it:
//                   Anthropic 5m-cache write is 1.25x base, read is 0.1x,
//                   so a single reuse within 5 minutes already wins.
//   - "auto"      → tools + system + latest user + durable message tail.
//   - "none"      → no auto placement; manual `CacheHint`s still flow.
//   - object form → exactly what the caller asked for.
const resolve = (policy: CachePolicy | undefined): CachePolicyObject => {
  if (policy === undefined || policy === "auto") return AUTO
  if (policy === "none") return NONE
  return policy
}

// Protocols whose wire format ignores inline cache markers (OpenAI's implicit
// prefix caching, Gemini's implicit + out-of-band CachedContent). Skip the
// whole policy pass for these — emitting hints would be harmless but pointless.
const RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])

const makeHint = (ttlSeconds: number | undefined): CacheHint =>
  ttlSeconds !== undefined ? new CacheHint({ type: "ephemeral", ttlSeconds }) : new CacheHint({ type: "ephemeral" })

const markLastTool = (tools: ReadonlyArray<ToolDefinition>, hint: CacheHint): ReadonlyArray<ToolDefinition> => {
  if (tools.length === 0) return tools
  const last = tools.length - 1
  if (tools[last]!.cache) return tools
  return tools.map((tool, i) => (i === last ? new ToolDefinition({ ...tool, cache: hint }) : tool))
}

const markLastSystem = (system: LLMRequest["system"], hint: CacheHint): LLMRequest["system"] => {
  if (system.length === 0) return system
  const last = system.length - 1
  if (system[last]!.cache) return system
  return system.map((part, i) => (i === last ? { ...part, cache: hint } : part))
}

const lastIndexOfRole = (messages: ReadonlyArray<Message>, role: Message["role"]): number =>
  messages.findLastIndex((m) => m.role === role)

// Per-turn injected context — goal continuation reminders with embedded token/time
// counters, compaction resume directives — is tagged `metadata.forge.internalContext`
// and changes on every request. Placing the message breakpoint there writes a cache
// entry that is never read and leaves the entire transcript between the system block
// and the tail uncached, re-billed at full input rate each turn. The stable boundary
// is the newest durable user message before the injected tail.
const isInternalContext = (message: Message) => {
  const forge = message.metadata?.["forge"]
  return typeof forge === "object" && forge !== null && "internalContext" in forge
}

const lastDurableUserIndex = (messages: ReadonlyArray<Message>): number => {
  const durable = messages.findLastIndex((m) => m.role === "user" && !isInternalContext(m))
  // A conversation whose only user messages are injected context (a bare goal
  // continuation, say) keeps today's placement rather than losing the breakpoint.
  return durable >= 0 ? durable : lastIndexOfRole(messages, "user")
}

// Thinking blocks cannot carry explicit breakpoints. Select the last part
// whose hint both inline-cache protocols lower, including trailing images.
const cacheable = (part: ContentPart) =>
  part.type === "text" || part.type === "media" || (part.type === "tool-result" && !part.providerExecuted)

const markMessageAt = (messages: ReadonlyArray<Message>, index: number, hint: CacheHint): ReadonlyArray<Message> => {
  if (index < 0 || index >= messages.length) return messages
  const target = messages[index]!
  if (target.content.length === 0) return messages
  const markAt = target.content.findLastIndex(cacheable)
  if (markAt < 0) return messages
  const existing = target.content[markAt]!
  if ("cache" in existing && existing.cache) return messages
  const nextContent = target.content.map((part, i) => (i === markAt ? ({ ...part, cache: hint } as ContentPart) : part))
  const next = new Message({ ...target, content: nextContent })
  // Single pass over `messages`, substituting the one updated entry. Long
  // conversations call this on every request, so avoid `.map()` here — its
  // closure dispatch and identity copies show up in profiling.
  const result = messages.slice()
  result[index] = next
  return result
}

const markMessages = (
  messages: ReadonlyArray<Message>,
  strategy: NonNullable<CachePolicyObject["messages"]>,
  hint: CacheHint,
): ReadonlyArray<Message> => {
  if (messages.length === 0) return messages
  if (strategy === "latest-user-message") return markMessageAt(messages, lastDurableUserIndex(messages), hint)
  if (strategy === "latest-assistant") return markMessageAt(messages, lastIndexOfRole(messages, "assistant"), hint)
  const start = Math.max(0, messages.length - strategy.tail)
  let next = messages
  for (let i = start; i < messages.length; i++) next = markMessageAt(next, i, hint)
  return next
}

export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  if (!RESPECTS_INLINE_HINTS.has(request.model.route.id)) return request
  const policy = resolve(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return request

  const hint = makeHint(policy.ttlSeconds)
  const tools = policy.tools ? markLastTool(request.tools, hint) : request.tools
  const system = policy.system ? markLastSystem(request.system, hint) : request.system
  const selected = policy.messages ? markMessages(request.messages, policy.messages, hint) : request.messages
  const messages =
    request.cache === undefined || request.cache === "auto"
      ? markMessageAt(
          selected,
          selected.findLastIndex((message) => !isInternalContext(message) && message.content.some(cacheable)),
          hint,
        )
      : selected

  if (tools === request.tools && system === request.system && messages === request.messages) return request
  return LLMRequest.update(request, { tools, system, messages })
}
