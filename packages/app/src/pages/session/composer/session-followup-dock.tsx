import { Button } from "@turenlabs/ui/button"
import { DockTray } from "@turenlabs/ui/dock-surface"
import { IconButton } from "@turenlabs/ui/icon-button"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  disabled?: boolean
  onSend: (id: string) => void
  onEdit: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    expanded: true,
  })

  const toggle = () => setStore("expanded", (value) => !value)
  const label = createMemo(() =>
    language.t(
      props.items.length === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other",
      { count: props.items.length },
    ),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray attach="bottom" data-component="session-followup-dock">
      <div class="flex min-h-10 items-center gap-2 px-3 py-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={store.expanded}
          onClick={toggle}
        >
          <span
            class="shrink-0 rounded-control bg-surface-raised-base px-2 py-0.5 text-12-medium text-text-strong"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {label()}
          </span>
          <Show when={!store.expanded && preview()}>
            <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">{preview()}</span>
          </Show>
        </button>
        <IconButton
          icon="chevron-down"
          size="normal"
          variant="ghost"
          style={{ transform: `rotate(${store.expanded ? 180 : 0}deg)` }}
          onClick={toggle}
          aria-label={language.t(store.expanded ? "session.followupDock.collapse" : "session.followupDock.expand")}
        />
      </div>

      <Show when={!store.expanded}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={store.expanded}>
        <div class="flex max-h-42 flex-col gap-1.5 overflow-y-auto px-3 pb-7 no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div data-slot="session-followup-item" class="flex min-w-0 items-center gap-2 py-1">
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
                <Button
                  data-action="session-followup-send"
                  size="small"
                  variant="secondary"
                  class="shrink-0"
                  disabled={props.disabled}
                  onClick={() => props.onSend(item.id)}
                >
                  {language.t("session.followupDock.sendNow")}
                </Button>
                <Button
                  data-action="session-followup-edit"
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={props.disabled}
                  onClick={() => props.onEdit(item.id)}
                >
                  {language.t("session.followupDock.edit")}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
