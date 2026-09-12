import { For, Show } from "solid-js"
import { StatusIndicatorV2 } from "@turenlabs/ui/v2/status-indicator-v2"
import type { SessionSwarmProgress } from "./session-subagent"

export function SessionSwarmProgressView(props: {
  progress: SessionSwarmProgress
  surface: "activity" | "subagents"
  embedded?: boolean
  onOpen?: () => void
}) {
  const invalid = () => props.progress.status === "invalid"
  const evidence = () =>
    props.progress.evidenceUpdatedAt === undefined
      ? "No board evidence yet"
      : `Latest evidence ${new Date(props.progress.evidenceUpdatedAt).toLocaleString()}`

  return (
    <section
      data-component="session-swarm-progress"
      data-surface={props.surface}
      data-swarm-status={props.progress.status}
      data-requested-count={props.progress.requested}
      classList={{
        "min-w-0 bg-v2-background-bg-base": true,
        "overflow-hidden rounded-surface border border-v2-border-border-base": !props.embedded,
      }}
    >
      <header class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-v2-border-border-muted px-5 py-3">
        <StatusIndicatorV2 tone={invalid() ? "danger" : "info"} live>
          Swarm
        </StatusIndicatorV2>
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-v2-text-faint">
          {props.progress.requested ?? "invalid"} worker budget
        </span>
        <span class="font-mono text-[10px] text-v2-text-faint">
          {props.progress.explicitCount ? "explicit" : "default"}
        </span>
        <Show when={props.onOpen}>
          <button
            type="button"
            class="ml-auto font-mono text-[10px] text-v2-text-accent hover:text-v2-text-strong"
            onClick={() => props.onOpen?.()}
          >
            Open subagents
          </button>
        </Show>
      </header>
      <div class="px-5 py-3">
        <p data-slot="session-swarm-objective" class="break-words text-[12px] leading-5 text-v2-text-base">
          {props.progress.objective || "A non-empty objective and valid worker count are required before dispatch."}
        </p>
        <Show when={!invalid()}>
          <div class="mt-3 grid grid-cols-3 border-y border-v2-border-border-muted sm:grid-cols-6">
            <SwarmMetric label="Admitted" value={props.progress.admitted} />
            <SwarmMetric label="Running" value={props.progress.running} />
            <SwarmMetric label="Completed" value={props.progress.completed} />
            <SwarmMetric label="Failed" value={props.progress.failed} danger={props.progress.failed > 0} />
            <SwarmMetric label="Cancelled" value={props.progress.cancelled} />
            <SwarmMetric label="Total" value={props.progress.total} />
          </div>
          <div class="mt-3 flex min-w-0 flex-wrap items-center gap-2">
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-v2-text-faint">Current lanes</span>
            <Show
              when={props.progress.lanes.length > 0}
              fallback={<span class="text-[11px] text-v2-text-muted">Waiting for dispatch or all lanes settled</span>}
            >
              <For each={props.progress.lanes.slice(0, 8)}>
                {(lane) => (
                  <span
                    data-slot="session-swarm-lane"
                    class="max-w-56 truncate border-l border-v2-border-border-strong pl-2 text-[11px] text-v2-text-muted"
                    title={lane}
                  >
                    {lane}
                  </span>
                )}
              </For>
            </Show>
          </div>
          <p data-slot="session-swarm-evidence" class="mt-2 font-mono text-[10px] text-v2-text-faint">
            {evidence()} · {props.progress.evidenceCount} room entr{props.progress.evidenceCount === 1 ? "y" : "ies"}
          </p>
        </Show>
        <Show when={invalid()}>
          <p class="mt-2 text-[11px] text-v2-state-fg-danger">No workers will be dispatched for this request.</p>
        </Show>
      </div>
    </section>
  )
}

function SwarmMetric(props: { label: string; value: number; danger?: boolean }) {
  return (
    <div
      data-swarm-metric={props.label.toLowerCase()}
      class="min-w-0 border-b border-r border-v2-border-border-muted px-2 py-2 last:border-r-0 sm:border-b-0"
    >
      <div class="font-mono text-[16px] text-v2-text-strong" classList={{ "text-v2-state-fg-danger": props.danger }}>
        {props.value}
      </div>
      <div class="truncate text-[9px] uppercase tracking-wide text-v2-text-faint">{props.label}</div>
    </div>
  )
}
