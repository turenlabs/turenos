import { DockTray } from "@turenlabs/ui/dock-surface"
import { Icon } from "@turenlabs/ui/icon"
import { IconButton } from "@turenlabs/ui/icon-button"
import { Tooltip } from "@turenlabs/ui/tooltip"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { orderPendingInputs } from "./session-pending-inputs"

/**
 * "Up next": every prompt admitted into a running turn that the runner has not yet
 * promoted, in the order it will deliver them. The transcript only shows a prompt once
 * it is promoted, so this tray is the one place a pending steer or queued input lives.
 */
export function SessionFollowupDock(props: {
  items: ReturnType<typeof orderPendingInputs>
  busy: (id: string) => boolean
  editBlocked: boolean
  onSteer: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ expanded: true })
  const toggle = () => setStore("expanded", (value) => !value)

  return (
    <DockTray attach="bottom" data-component="session-followup-dock" data-rule="info">
      <div class="flex min-h-9 items-center gap-2 pl-3 pr-1.5 pt-1.5">
        <button
          type="button"
          data-action="session-followup-toggle"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={store.expanded}
          onClick={toggle}
        >
          <span class="shrink-0 text-12-medium text-v2-text-text-strong">
            {language.t("session.pendingInputs.title")}
          </span>
          <span
            data-slot="session-followup-count"
            class="shrink-0 rounded-[3px] bg-v2-background-bg-layer-03 px-1.5 text-11-medium tabular-nums text-v2-text-text-base"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {props.items.length}
          </span>
          <span class="min-w-0 flex-1 truncate text-12-regular text-v2-text-text-muted">
            {store.expanded ? language.t("session.pendingInputs.hint") : props.items[0]?.text}
          </span>
        </button>
        <IconButton
          icon="chevron-down"
          size="small"
          variant="ghost"
          class="shrink-0 transition-transform duration-150"
          style={{ transform: `rotate(${store.expanded ? 180 : 0}deg)` }}
          onClick={toggle}
          aria-label={language.t(store.expanded ? "session.pendingInputs.collapse" : "session.pendingInputs.expand")}
        />
      </div>

      <Show when={store.expanded}>
        <ol class="flex max-h-48 flex-col overflow-y-auto pb-5 no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <li
                data-slot="session-followup-item"
                data-delivery={item.delivery}
                class="group/followup flex min-h-8 min-w-0 items-center gap-2 pl-3 pr-1.5 transition-opacity"
                classList={{ "opacity-60": props.busy(item.id) }}
              >
                <Tooltip
                  placement="top"
                  value={language.t(
                    item.delivery === "steer"
                      ? "session.pendingInputs.steer.description"
                      : "session.pendingInputs.queue.description",
                  )}
                >
                  <span
                    data-slot="session-followup-delivery"
                    class="flex h-5 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-11-medium tabular-nums"
                    classList={{
                      "bg-v2-state-bg-info text-v2-state-fg-info": item.delivery === "steer",
                      "bg-v2-background-bg-layer-03 text-v2-text-text-base": item.delivery === "queue",
                    }}
                  >
                    <Show when={item.delivery === "steer"}>
                      <Icon name="chevron-double-right" size="small" />
                    </Show>
                    {item.delivery === "steer"
                      ? language.t("session.pendingInputs.steer")
                      : language.t("session.pendingInputs.queue", { position: String(item.position) })}
                  </span>
                </Tooltip>
                <span class="min-w-0 flex-1 truncate text-13-regular text-v2-text-text-strong" title={item.text}>
                  {item.text}
                </span>
                <Show
                  when={!item.sending}
                  fallback={
                    <span class="shrink-0 pr-1.5 text-12-regular text-v2-text-text-muted" role="status">
                      {language.t("session.pendingInputs.sending")}
                    </span>
                  }
                >
                  <div class="flex shrink-0 items-center gap-0.5">
                    <Show when={item.delivery === "queue"}>
                      <Tooltip placement="top" value={language.t("session.pendingInputs.steerNow")}>
                        <IconButton
                          data-action="session-followup-send"
                          icon="chevron-double-right"
                          size="small"
                          variant="ghost"
                          disabled={props.busy(item.id)}
                          onClick={() => props.onSteer(item.id)}
                          aria-label={language.t("session.pendingInputs.steerNow")}
                        />
                      </Tooltip>
                    </Show>
                    <Tooltip
                      placement="top"
                      value={language.t(
                        props.editBlocked ? "session.pendingInputs.editBlocked" : "session.pendingInputs.edit",
                      )}
                    >
                      <IconButton
                        data-action="session-followup-edit"
                        icon="edit-small-2"
                        size="small"
                        variant="ghost"
                        // Disabled buttons swallow hover; let it reach the tooltip trigger.
                        class="disabled:pointer-events-none"
                        disabled={props.busy(item.id) || props.editBlocked}
                        onClick={() => props.onEdit(item.id)}
                        aria-label={language.t("session.pendingInputs.edit")}
                      />
                    </Tooltip>
                    <Tooltip placement="top" value={language.t("session.pendingInputs.remove")}>
                      <IconButton
                        data-action="session-followup-remove"
                        icon="close-small"
                        size="small"
                        variant="ghost"
                        disabled={props.busy(item.id)}
                        onClick={() => props.onRemove(item.id)}
                        aria-label={language.t("session.pendingInputs.remove")}
                      />
                    </Tooltip>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={!store.expanded}>
        <div class="h-5" aria-hidden="true" />
      </Show>
    </DockTray>
  )
}
