import {
  batch,
  createComputed,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  Show,
  Suspense,
  type ComponentProps,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@turenlabs/ui/icon"
import { StatusIndicatorV2, type StatusIndicatorV2Tone } from "@turenlabs/ui/v2/status-indicator-v2"
import { Part as MessagePart } from "@turenlabs/session-ui/message-part"
import type { Message, Todo, ToolPart } from "@turenlabs/sdk/v2"
import type { SessionLiveView } from "@/session-live-view"
import type { SessionSwarmProgress } from "./subagent/session-subagent"
import { SessionSwarmProgressView } from "./subagent/session-swarm-progress"
import { SessionLiveDock, SESSION_LIVE_VIEWS } from "./session-live-dock"
import { SessionPanelRenderContext } from "./session-panel-render"
import { activityOutput, groupSessionActivity, type SessionActivityKind } from "./goal/session-activity-model"

export type { SessionLiveView } from "@/session-live-view"

export { SessionLiveDock } from "./session-live-dock"

export function SessionLivePending(props: {
  view: () => SessionLiveView
  onViewChange: (view: SessionLiveView) => void
}) {
  return (
    <div data-component="session-live-pending" data-view={props.view()} class="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionLivePendingSurface view={props.view} />
      <div class="shrink-0 px-4 pb-4">
        <SessionLiveDock view={props.view} onViewChange={props.onViewChange} />
      </div>
    </div>
  )
}

function SessionLivePendingSurface(props: { view: () => SessionLiveView }) {
  const item = () => SESSION_LIVE_VIEWS.find((entry) => entry.value === props.view()) ?? SESSION_LIVE_VIEWS[0]
  const icon = () => item().icon

  return (
    <div class="min-h-0 min-w-0 flex-1 overflow-hidden p-4 md:px-6">
      <section class="mx-auto flex size-full max-w-[1080px] flex-col overflow-hidden rounded-surface border border-v2-border-border-base bg-v2-background-bg-base">
        <header class="flex h-12 shrink-0 items-center justify-between border-b border-v2-border-border-base px-4">
          <span class="flex items-center gap-2 text-13-medium text-v2-text-strong">
            <Icon name={icon()} size="small" />
            {item().label}
          </span>
          <StatusIndicatorV2 tone="info">Opening session</StatusIndicatorV2>
        </header>
        <div data-session-selected-surface={props.view()} aria-busy="true" class="min-h-0 flex-1" />
      </section>
    </div>
  )
}

export type SessionLiveToolCall = {
  id: string
  message: Message
  part: ToolPart
}

export type SessionTimelineItem = {
  id: string
  time: number
  kind: "prompt" | "tool" | "response"
  label: string
}

export type SessionLiveAgents = {
  active: number
  total: number
  completed?: number
  failed?: number
}

export type SessionLiveTool = {
  id: string
  description: string
  source: "builtin" | "session" | "mcp" | "mcp-broker"
}

export type SessionLiveMcpServer = {
  id: string
  status: "connected" | "connecting" | "disabled" | "needs-auth" | "failed" | "unknown"
  definitions: number
  detail?: string
}

export type SessionLiveMcpCapability = {
  key: string
  server: string
  name: string
  description?: string
  selected: boolean
}

export type SessionLiveToolExclusion = {
  id?: string
  server?: string
  source?: SessionLiveTool["source"]
  reason: string
  detail?: string
}

export function SessionLivePrototype(props: {
  view: () => SessionLiveView
  onViewChange: (view: SessionLiveView) => void
  sessionKey?: () => string
  deferRender?: () => boolean
  timeline: () => SessionTimelineItem[]
  toolCounts: () => { shell: number; total: number }
  toolCalls: () => SessionLiveToolCall[]
  availableTools?: () => ReadonlyArray<SessionLiveTool>
  mcpServers?: () => ReadonlyArray<SessionLiveMcpServer>
  mcpCapabilities?: () => ReadonlyArray<SessionLiveMcpCapability>
  toolExclusions?: () => ReadonlyArray<SessionLiveToolExclusion>
  toolsLoading?: () => boolean
  toolsError?: () => string | undefined
  onRefreshTools?: () => void
  onRevealTool?: (call: SessionLiveToolCall) => void
  files: () => number
  agents: () => SessionLiveAgents
  swarm?: () => SessionSwarmProgress | undefined
  objective?: () => string | undefined
  todos?: () => Todo[]
  todosReady?: () => boolean
  subagents: () => JSX.Element
  context: () => JSX.Element
  history: () => JSX.Element
  historyRetry?: () => void
  changes: () => JSX.Element
  harness?: () => JSX.Element
  terminal: () => JSX.Element
  whiteboard: () => JSX.Element
}) {
  const todos = () => props.todos?.() ?? []
  const todosReady = () => props.todosReady?.() ?? true
  // Non-visible panels stay unmounted until first visited. Terminal and Changes then
  // remain workspace-owned so their DOM/controllers survive session switches. Context
  // and Transcript are session-owned because their mounted reactive graphs directly
  // observe route params and can contain thousands of message-backed nodes.
  const [visited, setVisited] = createStore<Record<string, boolean>>({ history: true })
  const deferRender = () => props.deferRender?.() ?? false
  const sessionKey = () => props.sessionKey?.() ?? ""
  let renderedSessionKey = sessionKey()
  createComputed(() => {
    if (deferRender()) return
    const next = sessionKey()
    batch(() => {
      if (next !== renderedSessionKey) {
        renderedSessionKey = next
        setVisited({ context: false, history: false, whiteboard: false })
      }
      setVisited(props.view(), true)
    })
  })
  const selectedPending = () => {
    const selected = props.view()
    if (!visited[selected]) return true
    return deferRender() && selected === "context"
  }
  const panelHidden = (panel: SessionLiveView) => props.view() !== panel || selectedPending()

  return (
    <div data-component="session-live-surface" data-view={props.view()} class="flex min-h-0 min-w-0 flex-1 flex-col">
      <Show when={selectedPending()}>
        <SessionLivePendingSurface view={props.view} />
      </Show>
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("activity") }}>
        <Show when={visited.activity}>
          <LivePanel>
            <SessionLivePanelBoundary
              label="Activity"
              content={() => (
                <Activity
                  items={props.timeline}
                  toolCalls={props.toolCalls}
                  agents={props.agents}
                  swarm={() => props.swarm?.()}
                  files={props.files}
                  tools={props.toolCounts}
                  availableTools={() => props.availableTools?.() ?? []}
                  mcpServers={() => props.mcpServers?.() ?? []}
                  mcpCapabilities={() => props.mcpCapabilities?.() ?? []}
                  toolExclusions={() => props.toolExclusions?.() ?? []}
                  toolsLoading={() => props.toolsLoading?.() ?? false}
                  toolsError={() => props.toolsError?.()}
                  onRefreshTools={() => props.onRefreshTools?.()}
                  onRevealTool={(call) => props.onRevealTool?.(call)}
                  onViewChange={props.onViewChange}
                />
              )}
            />
          </LivePanel>
        </Show>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("todos") }}>
        <Show when={visited.todos}>
          <LivePanel>
            <SessionLivePanelBoundary
              label="ToDos"
              content={() => <TodoKanban objective={props.objective} todos={props.todos} />}
            />
          </LivePanel>
        </Show>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("context") }}>
        <Show when={visited.context && !deferRender()}>
          <LivePanel scroll={false}>
            <SessionLivePanelBoundary label="Context" content={props.context} />
          </LivePanel>
        </Show>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("subagents") }}>
        <Show when={visited.subagents}>
          <LivePanel>
            <SessionLivePanelBoundary label="Subagents" content={props.subagents} />
          </LivePanel>
        </Show>
      </div>

      <div
        class="min-h-0 min-w-0 flex-1 overflow-hidden"
        classList={{ hidden: panelHidden("changes") }}
        aria-busy={deferRender()}
        inert={deferRender()}
      >
        <Show when={visited.changes}>
          <SessionPanelRenderContext.Provider value={deferRender}>
            <SessionLivePanelBoundary label="Changes" content={props.changes} />
          </SessionPanelRenderContext.Provider>
        </Show>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("harness") }}>
        <Show when={visited.harness}>
          <LivePanel>
            <SessionLivePanelBoundary
              label="Harness"
              content={() =>
                props.harness ? (
                  props.harness()
                ) : (
                  <div class="flex min-h-full items-center justify-center rounded-control border border-border-weak-base bg-background-base px-6 py-12 text-center">
                    <div class="max-w-md">
                      <Icon name="shield" size="large" class="mx-auto text-text-weak" aria-hidden="true" />
                      <p class="mt-3 text-14-medium text-text-strong">Harness data is not connected yet.</p>
                      <p class="mt-1 text-13-regular text-text-weak">
                        Proposed changes, validation, and rollback controls will appear here when this session provides
                        a harness panel.
                      </p>
                    </div>
                  </div>
                )
              }
            />
          </LivePanel>
        </Show>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("whiteboard") }}>
        <Show when={visited.whiteboard && !deferRender()}>
          <LivePanel scroll={false}>
            <SessionLivePanelBoundary label="Whiteboard" content={props.whiteboard} />
          </LivePanel>
        </Show>
      </div>

      <div
        class="min-h-0 min-w-0 flex-1 overflow-auto"
        classList={{ hidden: panelHidden("terminal") }}
        aria-busy={deferRender()}
        inert={deferRender()}
      >
        <Show when={visited.terminal}>
          <SessionPanelRenderContext.Provider value={deferRender}>
            <SessionLivePanelBoundary label="Terminal" content={props.terminal} />
          </SessionPanelRenderContext.Provider>
        </Show>
      </div>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden" classList={{ hidden: panelHidden("history") }}>
        <Show when={visited.history}>
          <LivePanel scroll={false}>
            <SessionLivePanelBoundary label="Transcript" content={props.history} retry={props.historyRetry} />
          </LivePanel>
        </Show>
      </div>
    </div>
  )
}

function SessionLivePanelBoundary(props: { label: string; content: () => JSX.Element; retry?: () => void }) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div
          data-session-panel-error={props.label.toLowerCase()}
          class="flex min-h-full w-full items-center justify-center px-6 py-12 text-center"
        >
          <div class="max-w-md">
            <p class="text-14-medium text-v2-text-strong">{props.label} could not be loaded.</p>
            <p class="mt-1 break-words text-12-regular text-v2-text-muted">
              {error instanceof Error ? error.message : String(error)}
            </p>
            <button
              type="button"
              class="mt-4 rounded-control border border-v2-border-border-base bg-v2-background-bg-layer-02 px-3 py-1.5 text-12-medium text-v2-text-strong hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => {
                props.retry?.()
                reset()
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    >
      <Suspense
        fallback={
          <div
            data-session-panel-loading={props.label.toLowerCase()}
            class="flex min-h-full w-full items-center justify-center px-6 py-12 text-13-regular text-v2-text-muted"
          >
            Loading {props.label.toLowerCase()}...
          </div>
        }
      >
        {props.content()}
      </Suspense>
    </ErrorBoundary>
  )
}

function LivePanel(props: { children: JSX.Element; scroll?: boolean }) {
  return (
    <div
      classList={{
        "flex h-full min-h-0 min-w-0 flex-col": true,
        "overflow-auto px-6 pt-4 pb-10": props.scroll !== false,
        "overflow-hidden": props.scroll === false,
      }}
    >
      {props.children}
    </div>
  )
}

function SessionPerformance(props: {
  items: () => SessionTimelineItem[]
  tools: () => { shell: number; total: number }
  files: () => number
  agents: () => SessionLiveAgents
}) {
  const points = () => {
    const items = props.items()
    if (items.length === 0) return []
    const start = Math.min(...items.map((item) => item.time))
    const end = Math.max(...items.map((item) => item.time))
    const duration = Math.max(1, end - start)
    return items.map((item, index) => ({
      ...item,
      x: items.length === 1 ? 50 : 4 + ((item.time - start) / duration) * 92,
      height: item.kind === "prompt" ? 12 : item.kind === "tool" ? 8 : 16,
      index,
    }))
  }

  return (
    <section class="overflow-hidden rounded-surface border border-v2-border-border-base bg-v2-background-bg-base">
      <div class="flex items-center justify-between gap-3 border-b border-v2-border-border-muted px-5 py-3">
        <StatusIndicatorV2 tone="info">Performance</StatusIndicatorV2>
        <span class="font-mono text-[10px] text-v2-text-faint">{props.items().length} loaded events</span>
      </div>
      <div class="px-5 py-3">
        <svg
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          class="h-14 w-full"
          role="img"
          aria-label="Session activity timeline"
        >
          <line
            x1="4"
            x2="96"
            y1="19"
            y2="19"
            class="stroke-v2-border-border-muted"
            vector-effect="non-scaling-stroke"
          />
          <For each={points()}>
            {(item) => (
              <line
                x1={item.x}
                x2={item.x}
                y1={19 - item.height}
                y2="19"
                classList={{
                  "stroke-v2-icon-icon-base": item.kind === "prompt",
                  "stroke-v2-state-fg-info": item.kind === "tool",
                  "stroke-v2-state-fg-success": item.kind === "response",
                }}
                vector-effect="non-scaling-stroke"
              >
                <title>{item.label}</title>
              </line>
            )}
          </For>
        </svg>
      </div>
      <div class="grid grid-cols-2 border-t border-v2-border-border-muted @[40rem]:grid-cols-4">
        <PerformanceMetric label="Loaded shell commands" value={String(props.tools().shell)} />
        <PerformanceMetric label="Loaded tool calls" value={String(props.tools().total)} />
        <PerformanceMetric label="Loaded file changes" value={String(props.files())} />
        <PerformanceMetric label="Failures" value={String(props.agents().failed ?? 0)} />
      </div>
    </section>
  )
}

function PerformanceMetric(props: { label: string; value: string }) {
  return (
    <div class="min-w-0 border-b border-r border-v2-border-border-muted px-5 py-3 last:border-r-0 @[40rem]:border-b-0">
      <div class="font-mono text-[17px] leading-6 text-v2-text-strong">{props.value}</div>
      <div class="mt-0.5 truncate text-[10px] text-v2-text-faint">{props.label}</div>
    </div>
  )
}

const TODO_COLUMNS: {
  status: Todo["status"]
  label: string
  icon: ComponentProps<typeof Icon>["name"]
  tone: StatusIndicatorV2Tone
}[] = [
  { status: "in_progress", label: "In progress", icon: "task", tone: "info" },
  { status: "pending", label: "Pending", icon: "bullet-list", tone: "neutral" },
  { status: "completed", label: "Completed", icon: "circle-check", tone: "success" },
  { status: "cancelled", label: "Cancelled", icon: "circle-x", tone: "danger" },
]

function TodoKanban(props: { objective?: () => string | undefined; todos?: () => Todo[] }) {
  const objective = () => props.objective?.()
  const todos = () => props.todos?.() ?? []
  const done = () => todos().filter((todo) => todo.status === "completed").length
  const ordered = () => TODO_COLUMNS.flatMap((column) => todos().filter((todo) => todo.status === column.status))
  const tone = (): StatusIndicatorV2Tone => {
    if (todos().some((todo) => todo.status === "in_progress")) return "info"
    if (todos().length > 0 && done() === todos().length) return "success"
    return "neutral"
  }

  return (
    <section class="flex min-h-full min-w-0 flex-col overflow-hidden rounded-surface border border-v2-border-border-base bg-v2-background-bg-base">
      <header class="shrink-0 border-b border-v2-border-border-muted px-5 py-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <StatusIndicatorV2 tone={tone()}>ToDos</StatusIndicatorV2>
          <span class="font-mono text-[10px] text-v2-text-faint">
            {done()} / {todos().length} complete
          </span>
        </div>
        <Show when={objective()}>
          {(value) => <p class="mt-2 max-w-3xl break-words text-[13px] leading-5 text-v2-text-base">{value()}</p>}
        </Show>
        <div class="mt-3 h-1 overflow-hidden bg-v2-background-bg-layer-03">
          <div
            class="h-full bg-v2-state-fg-success transition-[width]"
            style={{ width: `${todos().length ? (done() / todos().length) * 100 : 0}%` }}
          />
        </div>
      </header>

      <Show
        when={ordered().length > 0}
        fallback={
          <div class="flex min-h-40 flex-1 items-center justify-center px-6 py-12 text-center">
            <p class="text-[13px] text-v2-text-muted">Goals and todos created by this session appear here.</p>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto">
          <For each={ordered()}>{(todo) => <TodoRow todo={todo} />}</For>
        </div>
      </Show>
    </section>
  )
}

function TodoRow(props: { todo: Todo }) {
  const column = () => TODO_COLUMNS.find((item) => item.status === props.todo.status)!

  return (
    <article
      data-status={props.todo.status}
      class="grid min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-3 border-b border-v2-border-border-muted px-5 py-3 last:border-b-0"
    >
      <Icon
        name={column().icon}
        size="small"
        class="mt-0.5 shrink-0"
        classList={{
          "text-v2-state-fg-info": column().tone === "info",
          "text-v2-state-fg-success": column().tone === "success",
          "text-v2-state-fg-danger": column().tone === "danger",
          "text-v2-icon-icon-muted": column().tone === "neutral",
        }}
        aria-hidden="true"
      />
      <p
        class="min-w-0 break-words text-[13px] leading-5"
        classList={{
          "text-v2-text-muted line-through": props.todo.status === "completed" || props.todo.status === "cancelled",
          "text-v2-text-strong": props.todo.status === "in_progress",
          "text-v2-text-base": props.todo.status === "pending",
        }}
      >
        {props.todo.content}
      </p>
      <StatusIndicatorV2 tone={column().tone}>{column().label}</StatusIndicatorV2>
    </article>
  )
}

function Activity(props: {
  items: () => SessionTimelineItem[]
  toolCalls: () => SessionLiveToolCall[]
  tools: () => { shell: number; total: number }
  files: () => number
  agents: () => SessionLiveAgents
  swarm: () => SessionSwarmProgress | undefined
  availableTools: () => ReadonlyArray<SessionLiveTool>
  mcpServers: () => ReadonlyArray<SessionLiveMcpServer>
  mcpCapabilities: () => ReadonlyArray<SessionLiveMcpCapability>
  toolExclusions: () => ReadonlyArray<SessionLiveToolExclusion>
  toolsLoading: () => boolean
  toolsError: () => string | undefined
  onRefreshTools: () => void
  onRevealTool: (call: SessionLiveToolCall) => void
  onViewChange: (view: SessionLiveView) => void
}) {
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean>>({})
  const [inventoryOpen, setInventoryOpen] = createStore({ value: false })
  const [filter, setFilter] = createSignal<"all" | SessionActivityKind>("all")
  const [search, setSearch] = createSignal("")
  const groups = createMemo(() => groupSessionActivity(props.toolCalls().toReversed()))
  const visibleGroups = createMemo(() => {
    const query = search().trim().toLowerCase()
    return groups().filter((group) => {
      if (filter() !== "all" && group.kind !== filter()) return false
      if (!query) return true
      return `${group.title} ${group.detail} ${group.calls.map((call) => `${call.part.tool} ${call.part.callID}`).join(" ")}`
        .toLowerCase()
        .includes(query)
    })
  })
  const groupOpen = (id: string, status: ToolPart["state"]["status"], kind: SessionActivityKind) =>
    toolOpen[id] ?? (status === "error" || kind === "network" || kind === "destructive")
  const allOpen = () =>
    visibleGroups().length > 0 && visibleGroups().every((group) => groupOpen(group.id, group.status, group.kind))
  const toggleAll = () => {
    const open = !allOpen()
    visibleGroups().forEach((group) => setToolOpen(group.id, open))
  }

  return (
    <div class="flex min-h-full flex-col gap-4">
      <section class="rounded-surface border border-v2-border-border-base bg-v2-background-bg-base">
        <div class="flex items-center justify-between border-b border-v2-border-border-muted px-5 py-3">
          <button
            type="button"
            class="flex items-center gap-2 text-left"
            aria-expanded={inventoryOpen.value}
            onClick={() => setInventoryOpen("value", !inventoryOpen.value)}
          >
            <StatusIndicatorV2 tone={props.availableTools().length > 0 ? "success" : "neutral"}>
              Session tools
            </StatusIndicatorV2>
            <span class="font-mono text-[10px] text-v2-text-faint">{props.availableTools().length} visible</span>
          </button>
          <button
            type="button"
            class="font-mono text-[10px] text-v2-text-muted transition-colors hover:text-v2-text-strong"
            onClick={props.onRefreshTools}
          >
            Refresh
          </button>
        </div>
        <Show when={inventoryOpen.value}>
          <Show
            when={!props.toolsLoading()}
            fallback={<p class="px-5 py-4 text-[12px] text-v2-text-muted">Loading tools…</p>}
          >
            <Show
              when={!props.toolsError()}
              fallback={<p class="px-5 py-4 text-[12px] text-v2-state-fg-danger">{props.toolsError()}</p>}
            >
              <Show
                when={props.availableTools().length > 0}
                fallback={
                  <p class="px-5 py-4 text-[12px] text-v2-text-muted">No tools materialized for this session.</p>
                }
              >
                <div class="grid max-h-56 grid-cols-1 overflow-y-auto sm:grid-cols-2">
                  <For each={props.availableTools()}>
                    {(tool) => (
                      <div class="min-w-0 border-b border-v2-border-border-muted px-5 py-2.5 sm:odd:border-r">
                        <p class="truncate font-mono text-[11px] text-v2-text-base">{tool.id}</p>
                        <p class="mt-0.5 line-clamp-2 text-[11px] leading-4 text-v2-text-muted">{tool.description}</p>
                        <p class="mt-1 font-mono text-[9px] uppercase tracking-wide text-v2-text-faint">
                          {tool.source}
                        </p>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show
                when={
                  props.mcpServers().length > 0 ||
                  props.mcpCapabilities().length > 0 ||
                  props.toolExclusions().length > 0
                }
              >
                <div class="border-t border-v2-border-border-muted px-5 py-3">
                  <p class="font-mono text-[10px] uppercase tracking-wide text-v2-text-faint">MCP state</p>
                  <Show when={props.mcpServers().length > 0}>
                    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      <For each={props.mcpServers()}>
                        {(server) => (
                          <span class="font-mono text-[10px] text-v2-text-muted">
                            {server.id}: {server.status} ({server.definitions})
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={props.mcpCapabilities().length > 0}>
                    <div class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                      <For each={props.mcpCapabilities()}>
                        {(capability) => (
                          <div class="min-w-0 text-[11px] text-v2-text-muted">
                            <span class="font-mono text-v2-text-base">{capability.key}</span>
                            <span class="ml-2 text-v2-text-faint">
                              {capability.selected ? "loaded" : "available, not loaded"}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={props.toolExclusions().length > 0}>
                    <div class="mt-3 border-t border-v2-border-border-muted pt-2">
                      <p class="font-mono text-[10px] uppercase tracking-wide text-v2-text-faint">Excluded</p>
                      <div class="mt-1 flex flex-col gap-1">
                        <For each={props.toolExclusions()}>
                          {(exclusion) => (
                            <span class="text-[11px] text-v2-text-muted">
                              <span class="font-mono text-v2-text-base">
                                {exclusion.id ?? exclusion.server ?? "MCP"}
                              </span>{" "}
                              {exclusion.reason}
                              <Show when={exclusion.detail}>: {exclusion.detail}</Show>
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </section>
      <Show when={props.swarm()}>{(swarm) => <SessionSwarmProgressView progress={swarm()} surface="activity" />}</Show>
      <SessionPerformance items={props.items} tools={props.tools} files={props.files} agents={props.agents} />
      <section class="order-first flex min-h-0 flex-1 flex-col overflow-hidden rounded-surface border border-v2-border-border-base bg-v2-background-bg-base">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-v2-border-border-muted px-5 py-3">
          <StatusIndicatorV2 tone={props.toolCalls().length > 0 ? "info" : "neutral"}>Activity</StatusIndicatorV2>
          <div class="flex items-center gap-4">
            <span class="font-mono text-[10px] text-v2-text-faint">
              {props.toolCalls().length} calls ·{" "}
              {formatActivityDuration(groups().reduce((sum, group) => sum + group.duration, 0))} ·{" "}
              {groups()
                .filter((group) => group.kind === "network")
                .reduce((sum, group) => sum + group.calls.length, 0)}{" "}
              network
            </span>
            <button
              type="button"
              class="font-mono text-[10px] text-v2-text-muted transition-colors hover:text-v2-text-strong"
              onClick={toggleAll}
            >
              {allOpen() ? "Collapse all" : "Expand all"}
            </button>
          </div>
        </div>
        <div class="flex flex-wrap gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-5 py-2.5">
          <label class="sr-only" for="session-activity-filter">
            Filter activity
          </label>
          <select
            id="session-activity-filter"
            value={filter()}
            class="h-8 rounded-control border border-v2-border-border-base bg-v2-background-bg-base px-2 text-[11px] text-v2-text-base outline-none focus:border-v2-border-border-focus"
            onInput={(event) => setFilter(event.currentTarget.value as "all" | SessionActivityKind)}
          >
            <option value="all">All activity</option>
            <option value="context">Read-only</option>
            <option value="write">Writes</option>
            <option value="verify">Verification</option>
            <option value="network">Network</option>
            <option value="destructive">Consequential</option>
            <option value="other">Other</option>
          </select>
          <label class="sr-only" for="session-activity-search">
            Search activity
          </label>
          <input
            id="session-activity-search"
            type="search"
            value={search()}
            placeholder="Search activity…"
            class="h-8 min-w-48 flex-1 rounded-control border border-v2-border-border-base bg-v2-background-bg-base px-3 text-[11px] text-v2-text-base outline-none placeholder:text-v2-text-faint focus:border-v2-border-border-focus"
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <Show
          when={visibleGroups().length > 0}
          fallback={
            <p class="px-5 py-8 text-[13px] text-v2-text-muted">
              {props.toolCalls().length > 0 ? "No activity matches these filters." : "Tool activity will appear here."}
            </p>
          }
        >
          <div class="min-h-0 flex-1 overflow-y-auto">
            <For each={visibleGroups()}>
              {(group) => (
                <article
                  data-activity-kind={group.kind}
                  data-activity-status={group.status}
                  class="border-b border-v2-border-border-muted last:border-b-0"
                  classList={{
                    "bg-v2-state-bg-danger/20": group.status === "error",
                    "bg-v2-state-bg-warning/15": group.kind === "network" || group.kind === "destructive",
                  }}
                >
                  <button
                    type="button"
                    class="grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                    aria-expanded={groupOpen(group.id, group.status, group.kind)}
                    onClick={() => setToolOpen(group.id, !groupOpen(group.id, group.status, group.kind))}
                  >
                    <span
                      aria-hidden="true"
                      class={`mt-1.5 size-1.5 rounded-full ${activityToneClass(group.status, group.outcome)}`}
                    />
                    <span class="min-w-0">
                      <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <strong class="text-[12px] font-medium text-v2-text-strong">{group.title}</strong>
                        <span class="truncate text-[11px] text-v2-text-muted">{group.detail}</span>
                      </span>
                      <span class="mt-1 flex flex-wrap gap-x-3 text-[10px] text-v2-text-faint">
                        <span>
                          {group.calls.length} {group.calls.length === 1 ? "call" : "calls"}
                        </span>
                        <Show when={group.duration > 0}>
                          <span>{formatActivityDuration(group.duration)}</span>
                        </Show>
                        <span>{activityStatusLabel(group.status)}</span>
                      </span>
                    </span>
                    <span class="flex items-center gap-3">
                      <Icon
                        name="chevron-right"
                        size="small"
                        class="text-v2-icon-icon-muted transition-transform"
                        classList={{ "rotate-90": groupOpen(group.id, group.status, group.kind) }}
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                  <Show when={groupOpen(group.id, group.status, group.kind)}>
                    <div class="border-t border-v2-border-border-muted bg-v2-background-bg-deep">
                      <Show when={group.kind === "write" && group.paths.length > 0}>
                        <div class="flex items-center justify-between gap-3 border-b border-v2-border-border-muted px-5 py-2.5">
                          <span class="min-w-0 truncate text-[11px] text-v2-text-muted">{group.paths.join(", ")}</span>
                          <button
                            type="button"
                            class="shrink-0 text-[10px] text-v2-text-accent hover:underline"
                            onClick={() => props.onViewChange("changes")}
                          >
                            Review diff
                          </button>
                        </div>
                      </Show>
                      <For each={group.calls}>
                        {(item) => (
                          <div
                            data-call-id={item.part.callID}
                            class="border-b border-v2-border-border-muted px-5 py-3 last:border-b-0"
                          >
                            <div class="mb-2 flex items-center justify-between gap-3">
                              <button
                                type="button"
                                class="min-w-0 truncate font-mono text-[10px] text-v2-text-accent hover:underline"
                                onClick={() => props.onRevealTool(item)}
                              >
                                {item.part.tool} · {item.part.callID}
                              </button>
                              <span class="shrink-0 font-mono text-[10px] text-v2-text-faint">
                                {formatActivityTime(activityTime(item))}
                              </span>
                            </div>
                            <Show when={item.part.state.status === "error"}>
                              <pre class="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-control border border-v2-state-border-danger bg-v2-state-bg-danger/30 p-3 text-[11px] text-v2-state-fg-danger">
                                {activityOutput(item.part)}
                              </pre>
                            </Show>
                            <MessagePart
                              part={item.part}
                              message={item.message}
                              defaultOpen={false}
                              toolOpen
                              onToolOpenChange={(open) => setToolOpen(group.id, open)}
                              deferToolContent
                              virtualizeDiff
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </article>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  )
}

function activityStatusLabel(status: ToolPart["state"]["status"]) {
  if (status === "completed") return "completed"
  if (status === "error") return "failed"
  return status === "running" ? "running" : "pending"
}

function activityToneClass(status: ToolPart["state"]["status"], outcome?: "success" | "failure" | "unknown") {
  if (status === "completed" && outcome !== "unknown") return "bg-v2-state-fg-success"
  if (status === "error") return "bg-v2-state-fg-danger"
  if (status === "running") return "bg-v2-state-fg-info"
  return "bg-v2-icon-icon-muted"
}

function formatActivityTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatActivityDuration(value: number) {
  if (value < 1_000) return `${value}ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
}

function activityTime(item: SessionLiveToolCall) {
  return "time" in item.part.state && item.part.state.time?.start
    ? item.part.state.time.start
    : item.message.time.created
}
