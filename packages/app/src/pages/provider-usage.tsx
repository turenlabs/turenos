import { ProviderIcon } from "@turenlabs/ui/provider-icon"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { useDialog } from "@turenlabs/ui/context/dialog"
import type { ProviderUsageResponse } from "@turenlabs/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useAgentsPanel } from "@/components/agents-panel-state"
import { useCommandPalette } from "@/context/command"
import { providerUsageQuery, tokenTotal, usageTotals } from "./provider-usage-model"
import { serverName } from "@/context/server"
import { LatestAutomationRuns } from "@/pages/loops/latest-runs"
import { IntelTab } from "@/pages/home/intel-tab"
import "./home/terminal-home.css"

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })
const dateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

type Usage = ProviderUsageResponse["providers"][number]
type Quota = ProviderUsageResponse["quotas"][number]
type QuotaWindow = Quota["windows"][number]
type UsageTotals = ReturnType<typeof usageTotals>
type HomeTab = "intel" | "workspace"

type ProviderSnapshot = {
  provider: { id: string; name: string }
  usage?: Usage
  quota?: Quota
}

export function ProviderUsagePage() {
  const dialog = useDialog()
  const panel = useAgentsPanel()
  const usage = useQuery(() => providerUsageQuery(panel))
  const [tab, setTab] = createSignal<HomeTab>("intel")
  const [workspaceTab, setWorkspaceTab] = createSignal<"automations" | "limits">("automations")

  const data = () => usage.data
  const providers = createMemo(() => {
    const ctx = panel.focusedServerCtx()
    if (!ctx) return []
    const observed = new Map(data()?.providers.map((item) => [item.providerID, item]))
    const quotas = new Map(data()?.quotas.map((item) => [item.providerID, item]))
    return ctx.sync.data.provider.connected.flatMap((id) => {
      const provider = ctx.sync.data.provider.all.get(id)
      if (!provider) return []
      return [{ provider, usage: observed.get(id), quota: quotas.get(id) }]
    })
  })
  const totals = createMemo(() => usageTotals(data()))
  const serverLabel = () => {
    const conn = panel.focusedServer()
    return conn ? serverName(conn) : "No server selected"
  }

  useCommandPalette(() => {
    void import("@/components/dialog-command-palette-v2").then(({ DialogCommandOnlyPaletteV2 }) => {
      void dialog.show(() => <DialogCommandOnlyPaletteV2 />)
    })
  })

  return (
    <main
      data-component="provider-usage"
      class="terminal-home h-full min-h-0 w-full min-w-0 flex-1 overflow-y-auto text-v2-text-text-base"
    >
      <div class="terminal-home-content">
        <h1 class="sr-only">Home</h1>
        <nav aria-label="Home sections" class="terminal-home-nav">
          <PageTab selected={tab() === "intel"} onSelect={() => setTab("intel")}>
            Intel
          </PageTab>
          <PageTab selected={tab() === "workspace"} onSelect={() => setTab("workspace")}>
            Workspace
          </PageTab>
        </nav>

        <Show when={tab() === "intel"}>
          <IntelTab />
        </Show>

        <Show when={tab() === "workspace"}>
          <header class="terminal-home-heading">
            <div class="terminal-home-title">
              <h2>Workspace</h2>
              <span class="terminal-home-meta">Activity, provider capacity, and usage</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="terminal-home-action" onClick={panel.focusSearch}>
                Find session
              </button>
              <button
                type="button"
                class="terminal-home-action"
                disabled={!panel.canOpenNewSession()}
                onClick={panel.openNewSession}
              >
                New session
              </button>
            </div>
          </header>
          <div class="terminal-home-subnav">
            <nav aria-label="Workspace sections" class="flex flex-wrap">
              <PageTab selected={workspaceTab() === "automations"} onSelect={() => setWorkspaceTab("automations")}>
                Automations
              </PageTab>
              <PageTab selected={workspaceTab() === "limits"} onSelect={() => setWorkspaceTab("limits")}>
                Provider limits
              </PageTab>
            </nav>
            <div class="terminal-home-meta flex items-center gap-2">
              <span
                class="size-1.5 rounded-full"
                classList={{
                  "bg-v2-state-fg-success": !!panel.focusedServerCtx(),
                  "bg-v2-state-fg-danger": !panel.focusedServerCtx(),
                }}
              />
              <span>{panel.focusedServerCtx() ? "Server connected" : "Server unavailable"}</span>
              <span aria-hidden="true" class="text-v2-text-text-faint">
                /
              </span>
              <span class="max-w-52 truncate">{serverLabel()}</span>
            </div>
          </div>
          <div class="terminal-home-workspace">
            <Show when={workspaceTab() === "automations"}>
              <LatestAutomationRuns layout="overview" />
            </Show>
            <Show when={workspaceTab() === "limits"}>
              <LimitsView
                providers={providers}
                data={data}
                totals={totals}
                connected={() => !!panel.focusedServerCtx()}
                isError={() => usage.isError}
                isFetching={() => usage.isFetching}
                onRefresh={() => void usage.refetch()}
              />
            </Show>
          </div>
        </Show>
      </div>
    </main>
  )
}

function PageTab(props: { selected: boolean; onSelect: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={props.selected} onClick={props.onSelect} class="terminal-home-tab">
      {props.children}
    </button>
  )
}

function HomeStat(props: { label: string; value: string; hint: string }) {
  return (
    <div class="bg-v2-background-bg-layer-01 px-4 py-4 sm:px-5">
      <div class="text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">{props.label}</div>
      <div class="mt-2 text-[24px] leading-none tracking-[-0.025em] [font-variant-numeric:tabular-nums] [font-weight:660]">
        {props.value}
      </div>
      <div class="mt-2 truncate text-[11px] text-v2-text-text-muted">{props.hint}</div>
    </div>
  )
}

function LimitsView(props: {
  providers: () => ProviderSnapshot[]
  data: () => ProviderUsageResponse | undefined
  totals: () => UsageTotals
  connected: () => boolean
  isError: () => boolean
  isFetching: () => boolean
  onRefresh: () => void
}) {
  return (
    <div class="flex flex-col gap-5">
      <section class="overflow-hidden border border-v2-border-border-base bg-v2-background-bg-layer-01">
        <div class="flex flex-col gap-4 px-5 py-5 sm:px-6 sm:py-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p class="text-[10px] uppercase tracking-[0.14em] text-v2-text-text-accent">Limits</p>
            <h2 class="mt-1 text-[22px] tracking-[-0.02em] [font-weight:620]">Capacity and usage</h2>
            <p class="mt-2 max-w-xl text-[12px] leading-5 text-v2-text-text-muted">
              Provider-reported windows on top, locally observed activity underneath. Refresh when you need a current
              read.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <Show when={props.data()?.end}>
              {(end) => <span class="text-[11px] text-v2-text-text-muted">Updated {relativeTime(end())}</span>}
            </Show>
            <Show when={props.isError() && props.data()}>
              <span class="text-[11px] text-v2-state-fg-warning">Refresh failed; showing cached data</span>
            </Show>
            <ButtonV2
              variant="outline"
              size="normal"
              icon="reset"
              disabled={props.isFetching()}
              onClick={props.onRefresh}
            >
              {props.isFetching() ? "Refreshing" : "Refresh limits"}
            </ButtonV2>
          </div>
        </div>
      </section>

      <Show
        when={props.connected()}
        fallback={<EmptyState title="Server unavailable" detail="Connect to a server to load provider limits." />}
      >
        <Show
          when={props.data()}
          fallback={
            <Show
              when={!props.isError()}
              fallback={
                <EmptyState title="Usage unavailable" detail="TurenOS could not load current provider limits." />
              }
            >
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <For each={[1, 2, 3, 4]}>
                  {() => (
                    <div class="h-48 animate-pulse border border-v2-border-border-muted bg-v2-background-bg-layer-01" />
                  )}
                </For>
              </div>
            </Show>
          }
        >
          <Show
            when={props.providers().length > 0}
            fallback={
              <EmptyState title="No connected providers" detail="Connect a model provider to see its limits here." />
            }
          >
            <details
              open
              aria-labelledby="capacity-heading"
              class="group overflow-hidden border border-v2-border-border-base bg-v2-background-bg-layer-01"
            >
              <summary class="flex cursor-pointer list-none items-center justify-between gap-4 border-b border-v2-border-border-muted px-5 py-4 select-none [&::-webkit-details-marker]:hidden sm:px-6">
                <div>
                  <p class="text-[10px] uppercase tracking-[0.14em] text-v2-text-text-accent">Connected providers</p>
                  <h3 id="capacity-heading" class="mt-1 text-[15px] [font-weight:620]">
                    Available capacity
                  </h3>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  <span class="rounded-full border border-v2-border-border-muted px-2.5 py-1 text-[11px] text-v2-text-text-muted">
                    {props.providers().length} connected
                  </span>
                  <IconV2
                    name="chevron-down"
                    class="text-v2-icon-icon-muted transition-transform group-open:rotate-180"
                  />
                </div>
              </summary>
              <div class="grid grid-cols-1 gap-px bg-v2-border-border-muted sm:grid-cols-2 xl:grid-cols-4">
                <For each={props.providers()}>{(item) => <ProviderCard {...item} />}</For>
              </div>
            </details>

            <section
              aria-label="Seven-day totals"
              class="grid grid-cols-2 gap-px border border-v2-border-border-base bg-v2-border-border-muted lg:grid-cols-4"
            >
              <HomeStat label="Tokens" value={compact.format(props.totals().tokens)} hint="7-day observed locally" />
              <HomeStat label="Turns" value={compact.format(props.totals().turns)} hint="Completed assistant turns" />
              <HomeStat label="Cache" value={compact.format(props.totals().cache)} hint="Read + write" />
              <HomeStat
                label="Est. cost"
                value={currency.format(props.totals().cost)}
                hint="API pricing, not subscriptions"
              />
            </section>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function ProviderCard(props: ProviderSnapshot) {
  return (
    <article class="flex min-w-0 flex-col gap-3 bg-v2-background-bg-layer-01 p-4 transition-colors hover:bg-v2-background-bg-layer-02 sm:p-5">
      <div class="flex min-w-0 items-center gap-2">
        <ProviderIcon id={props.provider.id} class="size-4 shrink-0 text-v2-icon-icon-base" />
        <h3 class="min-w-0 flex-1 truncate text-[13px] [font-weight:620]">{props.provider.name}</h3>
        <QuotaBadge quota={props.quota} />
      </div>
      <QuotaProgress quota={props.quota} />

      <div class="flex items-baseline justify-between gap-2 border-t border-v2-border-border-muted pt-3 text-[10px] text-v2-text-text-muted">
        <span>
          <span class="text-v2-text-text-base [font-variant-numeric:tabular-nums]">
            {compact.format(tokenTotal(props.usage))}
          </span>{" "}
          tokens
        </span>
        <span>
          <span class="text-v2-text-text-base [font-variant-numeric:tabular-nums]">
            {compact.format(props.usage?.turns ?? 0)}
          </span>{" "}
          turns
        </span>
      </div>
    </article>
  )
}

function QuotaProgress(props: { quota?: Quota; compact?: boolean }) {
  const tightest = createMemo(() => props.quota?.windows.toSorted((a, b) => b.usedPercent - a.usedPercent)[0])
  const remaining = createMemo(() => Math.min(100, Math.max(0, 100 - (tightest()?.usedPercent ?? 0))))
  const available = () => props.quota?.status === "available" && tightest()

  return (
    <Show
      when={available()}
      fallback={
        <p
          class={
            props.compact
              ? "mt-5 text-[11px] text-v2-text-text-muted"
              : "min-h-20 pt-2 text-[12px] leading-5 text-v2-text-text-muted"
          }
        >
          {quotaMessage(props.quota)}
        </p>
      }
    >
      <Show
        when={props.compact}
        fallback={
          <div class="flex flex-col gap-3 pt-2">
            <div class="flex items-baseline gap-2">
              <span class="text-[28px] leading-none tracking-[-0.03em] [font-variant-numeric:tabular-nums] [font-weight:660]">
                {formatPercent(remaining())}
              </span>
              <span class="min-w-0 truncate text-[10px] uppercase tracking-[0.08em] text-v2-text-text-muted">
                left / {tightest()?.label ?? "tightest limit"}
              </span>
            </div>
            <QuotaBar quota={props.quota} remaining={remaining} />
            <Show when={tightest()}>
              {(window) => (
                <div class="text-[10px] text-v2-text-text-muted">{resetLabel(window()) ?? "Rolling window"}</div>
              )}
            </Show>
          </div>
        }
      >
        <div class="mt-5 flex items-baseline gap-2">
          <span class="text-[24px] leading-none tracking-[-0.03em] [font-variant-numeric:tabular-nums] [font-weight:660]">
            {formatPercent(remaining())}
          </span>
          <span class="truncate text-[10px] uppercase tracking-[0.08em] text-v2-text-text-muted">left</span>
        </div>
        <QuotaBar quota={props.quota} remaining={remaining} />
        <p class="mt-2 truncate text-[10px] text-v2-text-text-muted">{tightest()!.label}</p>
      </Show>
    </Show>
  )
}

function QuotaBar(props: { quota?: Quota; remaining: () => number }) {
  return (
    <div
      class="h-1.5 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-03"
      title={props.quota?.windows
        .map((w) => `${w.label}: ${formatPercent(Math.min(100, Math.max(0, 100 - w.usedPercent)))} left`)
        .join("\n")}
    >
      <div
        class="h-full rounded-full bg-v2-icon-icon-base transition-[width] duration-500"
        classList={{
          "bg-v2-state-fg-danger": props.remaining() <= 10,
          "bg-v2-state-fg-warning": props.remaining() > 10 && props.remaining() <= 30,
        }}
        style={{ width: `${props.remaining()}%` }}
      />
    </div>
  )
}

function QuotaBadge(props: { quota?: Quota }) {
  const label = () => {
    if (!props.quota) return "Loading"
    if (props.quota.status === "available") return props.quota.source === "cli" ? "CLI live" : "Provider live"
    if (props.quota.status === "error") return "Unavailable"
    return "Not reported"
  }
  return (
    <span class="shrink-0 rounded-full border border-v2-border-border-muted px-2 py-1 text-[10px] text-v2-text-text-muted">
      {label()}
    </span>
  )
}

function quotaMessage(quota: Quota | undefined) {
  if (quota?.status === "error") return "Limit unavailable"
  if (quota?.detail) return quota.detail
  if (!quota) return "Collecting limit data..."
  return "No account quota reported"
}

function EmptyState(props: { title: string; detail: string; compact?: boolean }) {
  return (
    <div
      class={`flex w-full flex-col items-center justify-center border-dashed border-v2-border-border-muted px-6 text-center ${props.compact ? "min-h-32 border-t" : "min-h-56 border"}`}
    >
      <h2 class="text-[14px] [font-weight:620]">{props.title}</h2>
      <p class="mt-1 text-[12px] text-v2-text-text-muted">{props.detail}</p>
    </div>
  )
}

function resetLabel(window: QuotaWindow) {
  if (window.reset) return `Resets ${window.reset}`
  if (window.resetAt) return `Resets ${dateTime.format(window.resetAt)}`
  if (window.windowMinutes)
    return `${window.windowMinutes >= 60 ? `${window.windowMinutes / 60}h` : `${window.windowMinutes}m`} rolling window`
  return undefined
}

function formatPercent(value: number) {
  return `${value < 10 && value % 1 !== 0 ? value.toFixed(1) : Math.round(value)}%`
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}
