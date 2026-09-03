import type { Usage } from "./types.ts"

/**
 * USD per million tokens.
 *
 * These are list API prices. Both Claude Code and Codex are usually driven off
 * a *subscription* here, in which case the real marginal dollar cost is zero
 * and the meaningful currency is tokens against a rate limit. Modeled cost is
 * still useful because it puts a single comparable weight on input vs cached
 * vs output tokens, but never present it as "what this run cost".
 *
 * `null` for an entry means "we do not have a published price" — the benchmark
 * then reports modeledCostUsd as null rather than inventing a number.
 */
export interface Price {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  note: string
}

export const PRICES: Record<string, Price | null> = {
  // Anthropic list pricing for Claude Haiku 4.5. cacheWrite is quoted at the
  // 1-hour TTL rate (2x base input) because both Claude Code and TurenOS were
  // observed writing `ephemeral_1h` cache entries on this workload.
  "claude-haiku-4-5": {
    input: 1.0,
    cacheWrite: 2.0,
    cacheRead: 0.1,
    output: 5.0,
    note: "Anthropic list price, 1h cache TTL assumed for cache writes",
  },
  // OpenAI does not publish standalone API pricing for the Codex-only
  // `gpt-5.6-sol` model tier, and this account drives it off a ChatGPT
  // subscription. Deliberately unpriced.
  "gpt-5.6-sol": null,
  "gpt-5-mini": {
    input: 0.25,
    cacheWrite: 0,
    cacheRead: 0.025,
    output: 2.0,
    note: "OpenAI list price for gpt-5-mini",
  },
}

export function modelCost(pricingKey: string | null, usage: Usage): number | null {
  if (!pricingKey) return null
  const price = PRICES[pricingKey]
  if (!price) return null
  return (
    (usage.inputTokens * price.input +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    1_000_000
  )
}

export function priceNote(pricingKey: string | null): string {
  if (!pricingKey) return "unpriced"
  const price = PRICES[pricingKey]
  if (!price) return `unpriced (${pricingKey})`
  return price.note
}
