import type { ProviderUsageResponse } from "@turenlabs/sdk/v2/client"
import { ServerConnection } from "@/context/server"
import type { useAgentsPanel } from "@/components/agents-panel-state"

type Usage = ProviderUsageResponse["providers"][number]
const PROVIDER_USAGE_REFRESH_MS = 15_000

/**
 * Shared so the full page and the home card ask the same question the same
 * way. They also share a query key, so the second consumer reads the first
 * one's cache rather than issuing its own request.
 */
type Panel = ReturnType<typeof useAgentsPanel>

export function providerUsageQuery(panel: Panel) {
  const connection = panel.focusedServer()
  const ctx = panel.focusedServerCtx()
  const server = connection ? ServerConnection.key(connection) : undefined
  return {
    queryKey: ["provider", "usage", server],
    enabled: !!ctx && !!server,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      if (!ctx) throw new Error("Provider usage server unavailable")
      const response = await ctx.sdk.client.provider.usage(undefined, { signal })
      if (!response.data) throw new Error("Provider usage response was empty")
      return response.data
    },
    retry: false,
    staleTime: PROVIDER_USAGE_REFRESH_MS,
    gcTime: 10 * 60_000,
    // The server refreshes provider quotas behind its cached response. Poll
    // more often than that cache so a completed refresh is surfaced promptly.
    refetchInterval: (query: { state: { data?: ProviderUsageResponse } }) =>
      query.state.data?.quotas.length === (ctx?.sync.data.provider.connected.length ?? 0)
        ? PROVIDER_USAGE_REFRESH_MS
        : 3_000,
    refetchIntervalInBackground: true,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    structuralSharing: retainAvailableQuotas,
  }
}

export function tokenTotal(usage: Usage | undefined) {
  if (!usage) return 0
  return (
    usage.tokens.input +
    usage.tokens.output +
    usage.tokens.reasoning +
    usage.tokens.cache.read +
    usage.tokens.cache.write
  )
}

export function usageTotals(data: ProviderUsageResponse | undefined) {
  return (data?.providers ?? []).reduce(
    (result, item) => ({
      tokens: result.tokens + tokenTotal(item),
      turns: result.turns + item.turns,
      cost: result.cost + item.cost,
      cache: result.cache + item.tokens.cache.read + item.tokens.cache.write,
    }),
    { tokens: 0, turns: 0, cost: 0, cache: 0 },
  )
}

/**
 * A provider that errors on refresh keeps the capacity it last reported, so a
 * transient failure does not blank a number the user was reading.
 */
export function retainAvailableQuotas(
  previous: ProviderUsageResponse | undefined,
  next: ProviderUsageResponse,
): ProviderUsageResponse {
  if (!previous) return next
  const available = new Map(
    previous.quotas.filter((quota) => quota.status === "available").map((quota) => [quota.providerID, quota]),
  )
  return {
    ...next,
    quotas: next.quotas.map((quota) => (quota.status === "error" ? (available.get(quota.providerID) ?? quota) : quota)),
  }
}
