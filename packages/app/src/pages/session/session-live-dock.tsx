import { createUniqueId, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@turenlabs/ui/icon"
import type { Todo } from "@turenlabs/sdk/v2"
import type { SessionLiveView } from "@/session-live-view"
import "./session-live-dock.css"

export const SESSION_LIVE_VIEWS = [
  { value: "history", label: "Transcript", icon: "speech-bubble", primary: true },
  { value: "changes", label: "Changes", icon: "review", primary: true },
  { value: "whiteboard", label: "Whiteboard", icon: "edit", primary: true },
  { value: "browser", label: "Browser", icon: "link", primary: true },
  { value: "terminal", label: "Terminal", icon: "terminal", primary: false },
  { value: "todos", label: "ToDos", icon: "checklist", primary: false },
  { value: "subagents", label: "Subagents", icon: "subagent", primary: false },
  { value: "activity", label: "Activity", icon: "task", primary: false },
  { value: "context", label: "Context", icon: "brain", primary: false },
  { value: "harness", label: "Harness", icon: "shield", primary: false },
] as const

export function SessionLiveDock(props: {
  view: () => SessionLiveView
  onViewChange: (view: SessionLiveView) => void
  agents?: () => { active: number; failed?: number }
  todos?: () => Todo[]
}) {
  const [store, setStore] = createStore({ moreOpen: false })
  const menuID = createUniqueId()
  const secondary = () => SESSION_LIVE_VIEWS.find((item) => !item.primary && item.value === props.view())
  const activeAgents = () => props.agents?.().active ?? 0
  const failedAgents = () => props.agents?.().failed ?? 0
  const agentStatus = () => {
    const count = failedAgents() || activeAgents()
    if (!count) return ""
    return `${count} ${failedAgents() ? "failed" : "active"} ${count === 1 ? "subagent" : "subagents"}`
  }
  const count = (value: SessionLiveView) => {
    if (value === "subagents") {
      if (failedAgents() > 0) return { text: `${failedAgents()}`, danger: true }
      if (activeAgents() > 0) return { text: `${activeAgents()}`, danger: false }
      return
    }
    if (value === "todos") {
      const list = props.todos?.() ?? []
      if (list.length === 0) return
      const done = list.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length
      return { text: `${done}/${list.length}`, danger: false }
    }
    return
  }
  let moreButton!: HTMLButtonElement
  let moreMenu!: HTMLDivElement

  const close = () => {
    setStore("moreOpen", false)
    moreButton.focus()
  }
  const open = (last = false) => {
    setStore("moreOpen", true)
    queueMicrotask(() => {
      const items = moreMenu.querySelectorAll<HTMLButtonElement>("button")
      const selected = moreMenu.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ;(selected ?? items[last ? items.length - 1 : 0])?.focus()
    })
  }

  const pick = (value: SessionLiveView) => {
    setStore("moreOpen", false)
    props.onViewChange(value)
  }

  return (
    <div
      class="relative flex min-w-0 max-w-full justify-center"
      data-component="session-live-dock"
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          setStore("moreOpen", false)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !store.moreOpen) return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <Show when={store.moreOpen}>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close session view menu"
          class="fixed inset-0 z-40 cursor-default"
          onClick={close}
        />
        <div
          ref={moreMenu}
          id={menuID}
          role="menu"
          aria-label="More session views"
          class="absolute bottom-[calc(100%+8px)] right-0 z-50 flex w-56 max-w-[calc(100vw-24px)] flex-col gap-0.5 rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-1.5 shadow-[var(--v2-elevation-overlay)]"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"))
            const index = items.findIndex((item) => item === document.activeElement)
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
            items[next]?.focus()
          }}
        >
          <For each={SESSION_LIVE_VIEWS.filter((item) => !item.primary)}>
            {(item) => (
              <button
                type="button"
                role="menuitemradio"
                data-action={`session-live-dock-${item.value}`}
                aria-checked={props.view() === item.value}
                class="flex min-w-0 items-center gap-2 rounded-[8px] px-3 py-2 text-left text-[12px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base"
                classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": props.view() === item.value }}
                onClick={() => {
                  props.onViewChange(item.value)
                  close()
                }}
              >
                <Icon name={item.icon} size="small" />
                <span class="flex-1">{item.label}</span>
                <Show when={count(item.value)}>
                  {(badge) => (
                    <span class="text-[10px]" classList={{ "text-v2-state-fg-danger": badge().danger }}>
                      {badge().text}
                    </span>
                  )}
                </Show>
                <Show when={props.view() === item.value}>
                  <Icon name="check-small" size="small" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <nav
        aria-label="Session views"
        class="flex w-fit max-w-full flex-wrap items-center justify-center gap-0.5 rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-layer-01/95 p-1 shadow-[var(--v2-elevation-floating)] backdrop-blur-md"
      >
        <For each={SESSION_LIVE_VIEWS.filter((item) => item.primary)}>
          {(item) => (
            <button
              type="button"
              data-action={`session-live-dock-${item.value}`}
              data-selected={props.view() === item.value ? "true" : undefined}
              aria-pressed={props.view() === item.value}
              aria-label={item.label}
              title={item.label}
              class="flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[11px] text-v2-text-text-muted outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-v2-border-border-focus sm:px-3"
              classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": props.view() === item.value }}
              onClick={() => pick(item.value)}
            >
              <Icon name={item.icon} size="small" />
              <span data-slot="session-view-label">{item.label}</span>
            </button>
          )}
        </For>
        <div data-slot="dock-secondary">
          <span class="mx-0.5 h-4.5 w-px self-center bg-v2-border-border-base" aria-hidden="true" />
          <For each={SESSION_LIVE_VIEWS.filter((item) => !item.primary)}>
            {(item) => (
              <button
                type="button"
                data-action={`session-live-dock-${item.value}`}
                data-selected={props.view() === item.value ? "true" : undefined}
                aria-pressed={props.view() === item.value}
                aria-label={item.label}
                title={item.label}
                class="flex h-9 min-w-8 items-center justify-center gap-1 rounded-[8px] px-1.5 text-[11px] text-v2-text-text-muted outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": props.view() === item.value }}
                onClick={() => pick(item.value)}
              >
                <Icon name={item.icon} size="small" />
                <Show when={count(item.value)}>
                  {(badge) => (
                    <span
                      data-slot="dock-count"
                      class="font-mono text-[9px] leading-none"
                      classList={{
                        "text-v2-state-fg-danger": badge().danger,
                        "text-v2-icon-icon-accent": !badge().danger && item.value === "subagents",
                        "text-v2-text-text-faint": !badge().danger && item.value !== "subagents",
                      }}
                    >
                      {badge().text}
                    </span>
                  )}
                </Show>
              </button>
            )}
          </For>
        </div>
        <button
          ref={moreButton}
          type="button"
          data-slot="dock-more"
          data-action="session-live-dock-more"
          aria-label={["More session views", secondary() && `${secondary()!.label} selected`, agentStatus()]
            .filter(Boolean)
            .join(", ")}
          aria-expanded={store.moreOpen}
          aria-haspopup="menu"
          title="More session views"
          aria-controls={store.moreOpen ? menuID : undefined}
          aria-pressed={!!secondary()}
          class="relative h-9 min-w-0 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[11px] text-v2-text-text-muted outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-v2-border-border-focus sm:px-3"
          classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": store.moreOpen || !!secondary() }}
          onClick={() => (store.moreOpen ? close() : open())}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
            event.preventDefault()
            open(event.key === "ArrowUp")
          }}
        >
          <Icon name="dot-grid" size="small" />
          <span data-slot="session-view-label">More</span>
          <Show when={activeAgents() > 0 || failedAgents() > 0}>
            <span
              class="absolute right-1 top-1 size-1.5 rounded-full"
              classList={{
                "bg-v2-state-fg-danger": failedAgents() > 0,
                "bg-v2-icon-icon-accent": failedAgents() === 0,
              }}
              aria-hidden="true"
            />
          </Show>
        </button>
      </nav>
    </div>
  )
}
