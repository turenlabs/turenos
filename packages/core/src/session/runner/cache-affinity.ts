export * as CacheAffinity from "./cache-affinity"

/**
 * Headers that keep one conversation on one server or replica, so a provider's prompt cache is reachable
 * on the next turn. This is the policy the v1 runtime applied to every provider (`x-session-affinity`,
 * `X-Session-Id`, `x-parent-session-id`); the V2 runner had dropped it.
 *
 * - `x-session-affinity`: Fireworks pins repeated prefixes to one replica with it.
 * - `x-session-id`: OpenRouter uses it as the explicit sticky-routing key (otherwise it infers one only
 *   after a cache hit is observed). Header names are case-insensitive, so one spelling suffices.
 * - `x-grok-conv-id`: xAI routes a conversation to one server, and its cache entries are per server.
 * - `x-parent-session-id`: ties a subagent to its parent for providers and gateways that trace it.
 *
 * opencode's own gateway keys on `x-opencode-session`, which the route already carries
 * (`session/runner/model.ts`), so it gets nothing here. The ChatGPT backend has its own headers, see
 * `OpenAICodex.affinityHeaders`. Providers with no routing key (Anthropic, Bedrock, Gemini, DeepSeek) ignore
 * unknown headers and cache from cache hints or by prefix, so the generic pair is harmless to them.
 *
 * The identifier is the same session-derived value sent as the body cache key, never a user or account id.
 */
export const headers = (input: {
  readonly providerID: string
  readonly baseURL: unknown
  readonly key: string
  readonly parentSessionID?: string
}) => {
  if (input.key.length === 0 || input.providerID.startsWith("opencode")) return undefined
  const host =
    typeof input.baseURL === "string" && URL.canParse(input.baseURL) ? new URL(input.baseURL).hostname : undefined
  return {
    "x-session-affinity": input.key,
    "x-session-id": input.key,
    ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
    ...(host === "api.x.ai" ? { "x-grok-conv-id": input.key } : {}),
  }
}
