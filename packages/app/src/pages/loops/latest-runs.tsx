import { useNavigate } from "@solidjs/router"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { loopApi, responseData, type LoopInfo, type LoopRun } from "./api"
import { localLoopServer } from "./local-server"
import { isActiveRun } from "./run-view"

import {
  finalExcerpt,
  latestRunsAcross,
  nextRunLabel,
  outcomeLine,
  relativeAgo,
  type LatestRun,
} from "./latest-runs-data"

const DOT_TONE: Record<string, string> = {
  succeeded: "bg-v2-state-fg-success",
  failed: "bg-v2-state-fg-danger",
  running: "bg-v2-state-fg-warning",
  claimed: "bg-v2-state-fg-warning",
}

const runDot = (run: LoopRun) =>
  `${DOT_TONE[run.status] ?? "bg-v2-text-text-faint"}${isActiveRun(run) ? " animate-pulse" : ""}`

function CopyButton(props: { text: () => string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: number | undefined
  const copy = (event: MouseEvent) => {
    event.stopPropagation()
    const clipboard = navigator.clipboard
    if (!clipboard) return
    window.clearTimeout(timer)
    void clipboard.writeText(props.text()).then(
      () => {
        setCopied(true)
        timer = window.setTimeout(() => setCopied(false), 1_200)
      },
      () => setCopied(false),
    )
  }
  return (
    <button
      type="button"
      class="font-mono text-[11px] text-v2-text-text-muted outline-none transition-colors hover:text-v2-text-text-strong focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
      onClick={copy}
    >
      {copied() ? "copied" : "copy"}
    </button>
  )
}

function useLatestRuns(limit: number) {
  const server = useServer()
  const global = useGlobal()
  const connection = createMemo(() => localLoopServer(server.list, server.scope))
  const [loaded, setLoaded] = createSignal(false)
  const [entries, setEntries] = createSignal<ReadonlyArray<{ automation: LoopInfo; runs: LoopRun[] }>>([])
  onMount(() => {
    const current = connection()
    if (!current) {
      setLoaded(true)
      return
    }
    const api = loopApi(global.ensureServerCtx(current).sdk.client)
    void api
      .list()
      .then(responseData)
      .then((items) =>
        Promise.all(
          items.map((automation) =>
            api
              .runList({ loopID: automation.id })
              .then(responseData)
              .then((runs) => ({ automation, runs }))
              .catch(() => ({ automation, runs: [] })),
          ),
        ),
      )
      .then((next) => setEntries(next))
      .catch(() => setEntries([]))
      .finally(() => setLoaded(true))
  })
  const runs = createMemo(() => latestRunsAcross(entries(), limit))
  return { loaded, runs }
}

function RunHeadline(props: { item: LatestRun }) {
  return (
    <>
      <span class={`h-2 w-2 shrink-0 rounded-full ${runDot(props.item.run)}`} />
      <span class="truncate text-[13px] text-v2-text-text-strong [font-weight:550]">{props.item.loopName}</span>
      <span class="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-muted">
        {outcomeLine(props.item.run, props.item.steps)}
      </span>
      <span class="shrink-0 font-mono text-[10px] text-v2-text-text-faint">
        {isActiveRun(props.item.run) ? "live" : relativeAgo(Date.now(), Number(props.item.run.scheduledAt))}
      </span>
    </>
  )
}

function RunLinks(props: { item: LatestRun; excerpt: string }) {
  const navigate = useNavigate()
  return (
    <div class="mt-2 flex items-center gap-3">
      <CopyButton text={() => props.excerpt} />
      <button
        type="button"
        data-action="latest-run-open"
        class="ml-auto font-mono text-[11px] text-v2-text-text-muted outline-none transition-colors hover:text-v2-text-text-strong focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
        onClick={() => navigate(`/automations/${props.item.loopID}?view=runs`)}
      >
        Open run in Automations →
      </button>
    </div>
  )
}

function ExpandableRun(props: { item: LatestRun; expanded: boolean; onToggle: () => void }) {
  const excerpt = () => finalExcerpt(props.item.run, props.item.steps)
  return (
    <>
      <button
        type="button"
        data-action="latest-run-toggle"
        aria-expanded={props.expanded}
        class="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-v2-background-bg-layer-02 focus-visible:bg-v2-background-bg-layer-02"
        onClick={props.onToggle}
      >
        <RunHeadline item={props.item} />
        <span class="shrink-0 text-[11px] text-v2-text-text-faint">{props.expanded ? "▾" : "▸"}</span>
      </button>
      <Show when={props.expanded && excerpt()}>
        {(text) => (
          <div class="border-t border-v2-border-border-subtle px-3.5 py-2.5 pl-8">
            <p class="whitespace-pre-wrap font-mono text-[11px] leading-5 text-v2-text-text-base">{text()}</p>
            <RunLinks item={props.item} excerpt={text()} />
          </div>
        )}
      </Show>
    </>
  )
}

function StaticRun(props: { item: LatestRun }) {
  const excerpt = () => finalExcerpt(props.item.run, props.item.steps)
  return (
    <div class="px-5 py-3.5">
      <div class="flex items-center gap-2.5">
        <RunHeadline item={props.item} />
      </div>
      <Show when={excerpt()}>
        {(text) => (
          <>
            <p class="mt-2 max-w-3xl whitespace-pre-wrap font-mono text-[11px] leading-5 text-v2-text-text-base">
              {text()}
            </p>
            <RunLinks item={props.item} excerpt={text()} />
          </>
        )}
      </Show>
    </div>
  )
}

/**
 * Latest automation runs for surfaces outside /automations: an expandable
 * group on Agents home and a Latest runs card on workspace Overview.
 * Hidden entirely until at least one run exists.
 */
export function LatestAutomationRuns(props: { layout: "home" | "overview"; limit?: number }) {
  const navigate = useNavigate()
  const limit = () => props.limit ?? 3
  const { loaded, runs } = useLatestRuns(limit())
  const [expanded, setExpanded] = createSignal(0)
  const visible = () => loaded() && runs().length > 0

  return (
    <Show when={visible()}>
      <Show
        when={props.layout === "home"}
        fallback={
          <section
            data-component="latest-automation-runs"
            class="overflow-hidden border border-v2-border-border-base bg-v2-background-bg-layer-01"
          >
            <div class="flex items-end justify-between gap-3 border-b border-v2-border-border-subtle px-5 py-4">
              <div>
                <p class="text-[10px] uppercase tracking-[0.14em] text-v2-text-text-accent">Automations</p>
                <h2 class="mt-1 text-[17px] tracking-[-0.015em] [font-weight:620]">Latest runs</h2>
                <p class="mt-1 text-[12px] text-v2-text-text-muted">
                  What your scheduled workflows did most recently — and what came out.
                </p>
              </div>
              <button
                type="button"
                data-action="latest-runs-open-automations"
                class="shrink-0 whitespace-nowrap text-[12px] text-v2-text-text-muted outline-none transition-colors hover:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                onClick={() => navigate("/automations")}
              >
                Open automations →
              </button>
            </div>
            <For each={runs()}>
              {(item) => (
                <div class="border-b border-v2-border-border-subtle last:border-b-0">
                  <StaticRun item={item} />
                </div>
              )}
            </For>
          </section>
        }
      >
        <div class="flex flex-col pb-2 pr-3">
          <div class="flex items-baseline justify-between">
            <h2 class="text-[12px] text-v2-text-text-strong [font-weight:650]">Automation runs</h2>
            <button
              type="button"
              data-action="latest-runs-open-automations"
              class="font-mono text-[11px] text-v2-text-text-muted outline-none transition-colors hover:text-v2-text-text-strong focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
              onClick={() => navigate("/automations")}
            >
              View all in Automations →
            </button>
          </div>
          <div class="mt-2 overflow-hidden rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01">
            <For each={runs()}>
              {(item, index) => (
                <div class="border-b border-v2-border-border-subtle last:border-b-0">
                  <ExpandableRun
                    item={item}
                    expanded={expanded() === index()}
                    onToggle={() => setExpanded(expanded() === index() ? -1 : index())}
                  />
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </Show>
  )
}
