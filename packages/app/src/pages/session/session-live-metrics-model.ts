import type { AssistantMessage, ProviderUsageResponse } from "@turenlabs/sdk/v2/client"

type Quotas = ProviderUsageResponse["quotas"]

/**
 * Share of the latest prompt served from the provider's prompt cache. Reads are
 * measured against the whole prompt (uncached input + reads + writes), matching
 * how getSessionContext defines `prompt`.
 */
export function cacheHitRate(message: AssistantMessage | undefined): number | undefined {
  if (!message) return
  const prompt = message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
  if (prompt <= 0) return
  return Math.round((message.tokens.cache.read / prompt) * 100)
}

/**
 * The provider's fullest quota window, when it reports one. Providers that do
 * not publish limits return no matching entry and the chip stays hidden.
 */
export function providerQuota(
  quotas: Quotas | undefined,
  providerID: string | undefined,
): { usedPercent: number; windows: Array<{ label: string; usedPercent: number; reset?: string; resetAt?: number }>; plan?: string } | undefined {
  if (!quotas || !providerID) return
  const entry = quotas.find((quota) => quota.providerID === providerID && quota.status === "available")
  if (!entry?.windows.length) return
  const tightest = Math.max(...entry.windows.map((window) => window.usedPercent))
  return { usedPercent: Math.round(tightest), windows: entry.windows, plan: entry.plan }
}
