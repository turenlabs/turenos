import { Show, createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { getSessionContext } from "@/components/session/session-context-metrics"
import { useGlobal } from "@/context/global"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { providerUsageServerQuery } from "@/pages/provider-usage-model"
import { useSessionLayout } from "./session-layout"
import { cacheHitRate, providerQuota } from "./session-live-metrics-model"

export function SessionLiveMetrics() {
  const sync = useSync()
  const sdk = useSDK()
  const global = useGlobal()
  const server = useServer()
  const local = useLocal()
  const providers = useProviders(() => sdk().directory)
  const { params } = useSessionLayout()

  const ctx = createMemo(() => {
    const conn = server.current
    if (!conn) return
    if (global.servers.health[ServerConnection.key(conn)]?.healthy !== true) return
    return global.ensureServerCtx(conn)
  })
  const usage = useQuery(() => providerUsageServerQuery(server.current, ctx()))

  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const cache = createMemo(() => cacheHitRate(context()?.message))
  const quota = createMemo(() => providerQuota(usage.data?.quotas, local.model.current()?.provider.id))

  const contextTitle = createMemo(() => {
    const item = context()
    if (!item) return ""
    if (!item.limit) return `Context window — ${item.total.toLocaleString()} tokens`
    return `Context window — ${item.total.toLocaleString()} / ${item.limit.toLocaleString()} tokens`
  })
  const cacheTitle = createMemo(() => {
    const item = context()
    if (!item) return ""
    return `Cache hit — ${item.message.tokens.cache.read.toLocaleString()} of ${item.prompt.toLocaleString()} prompt tokens served from cache`
  })
  const quotaTitle = createMemo(() => {
    const item = quota()
    if (!item) return ""
    const provider = local.model.current()?.provider
    const name = provider?.name ?? provider?.id ?? "Provider"
    const lines = item.windows.map(
      (window) => `${window.label}: ${Math.round(window.usedPercent)}%${window.reset ? ` · resets ${window.reset}` : ""}`,
    )
    return `${name} limit${item.plan ? ` (${item.plan})` : ""}\n${lines.join("\n")}`
  })

  return (
    <Show when={context()?.usage != null || cache() != null || quota()}>
      <span data-slot="dock-metric-separator" aria-hidden="true">
        |
      </span>
      <Show when={context()?.usage != null}>
        <span data-slot="dock-metric" title={contextTitle()} aria-label={contextTitle()}>
          ctx {context()!.usage}%
        </span>
      </Show>
      <Show when={quota()}>
        {(item) => (
          <span data-slot="dock-metric" title={quotaTitle()} aria-label={quotaTitle()}>
            limit {item().usedPercent}%
          </span>
        )}
      </Show>
      <Show when={cache() != null}>
        <span data-slot="dock-metric" title={cacheTitle()} aria-label={cacheTitle()}>
          cache {cache()}%
        </span>
      </Show>
    </Show>
  )
}
