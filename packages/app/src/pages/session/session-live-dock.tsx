import { For, Show, type JSX } from "solid-js"
import { Icon } from "@turenlabs/ui/icon"
import type { Todo } from "@turenlabs/sdk/v2"
import type { SessionLiveView } from "@/session-live-view"
import "./session-live-dock.css"

export const SESSION_LIVE_VIEWS = [
  { value: "history", label: "Conversation", icon: "speech-bubble" },
  { value: "terminal", label: "Terminal", icon: "terminal" },
  { value: "changes", label: "Changes", icon: "review" },
  { value: "browser", label: "Browser", icon: "link" },
  { value: "whiteboard", label: "Whiteboard", icon: "edit" },
  { value: "todos", label: "Todos", icon: "checklist" },
  { value: "subagents", label: "Subagents", icon: "subagent" },
  { value: "activity", label: "Activity", icon: "task" },
  { value: "context", label: "Context", icon: "brain" },
  { value: "harness", label: "Harness", icon: "shield" },
] as const

export function SessionLiveDock(props: {
  view: () => SessionLiveView
  onViewChange: (view: SessionLiveView) => void
  agents?: () => { active: number; failed?: number }
  todos?: () => Todo[]
  children?: JSX.Element
}) {
  const count = (value: SessionLiveView) => {
    if (value === "subagents") {
      const failed = props.agents?.().failed ?? 0
      const active = props.agents?.().active ?? 0
      if (failed > 0) return { text: `${failed} failed subagents`, danger: true }
      if (active > 0) return { text: `${active} active subagents`, danger: false }
    }
    if (value === "todos") {
      const list = props.todos?.() ?? []
      if (list.length === 0) return
      const done = list.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length
      return { text: `${done}/${list.length} todos completed`, danger: false }
    }
  }

  return (
    <nav data-component="session-live-dock" aria-label="Session views">
      <For each={SESSION_LIVE_VIEWS}>
        {(item) => (
          <button
            type="button"
            data-action={`session-live-dock-${item.value}`}
            data-selected={props.view() === item.value ? "true" : undefined}
            aria-pressed={props.view() === item.value}
            aria-label={[item.label, count(item.value)?.text].filter(Boolean).join(", ")}
            title={[item.label, count(item.value)?.text].filter(Boolean).join(" / ")}
            onClick={() => props.onViewChange(item.value)}
          >
            <Icon name={item.icon} size="small" />
            <Show when={count(item.value)}>
              {(badge) => (
                <span
                  data-slot="dock-status"
                  classList={{
                    "bg-v2-state-fg-danger": badge().danger,
                    "bg-v2-icon-icon-accent": !badge().danger,
                  }}
                  aria-hidden="true"
                />
              )}
            </Show>
          </button>
        )}
      </For>
      {props.children}
    </nav>
  )
}
