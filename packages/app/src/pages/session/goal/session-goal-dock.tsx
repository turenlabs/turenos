import { Button } from "@turenlabs/ui/button"
import { DockTray } from "@turenlabs/ui/dock-surface"
import { IconButton } from "@turenlabs/ui/icon-button"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import {
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  formatSessionGoalDuration,
  sessionGoalDisplayedSeconds,
  sessionGoalElapsedSeconds,
  sessionGoalIsAccruing,
  sessionGoalObjectiveError,
  sessionGoalRuleTone,
  sessionGoalStatusLabel,
  type SessionGoalInfo,
} from "./session-goal"

export function SessionGoalDock(props: {
  goal: SessionGoalInfo
  attach?: "none" | "top" | "bottom"
  editRequest?: number
  disabled?: boolean
  onEdit: (input: { objective: string }) => void
  onPause: () => void
  onResume: () => void
  onClear: () => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    expanded: false,
    editing: false,
    objective: props.goal.objective,
  })

  createEffect(() => {
    props.goal.id
    props.goal.objective
    setStore({
      objective: props.goal.objective,
      editing: false,
    })
  })

  createEffect(() => {
    if (!props.editRequest) return
    setStore({ expanded: true, editing: true })
  })

  const status = createMemo(() => language.t(sessionGoalStatusLabel(props.goal.status)))

  // Re-anchor whenever the server checkpoints, so the local offset never double-counts.
  const [observedAt, setObservedAt] = createSignal(Date.now())
  createEffect(() => {
    sessionGoalElapsedSeconds(props.goal)
    setObservedAt(Date.now())
  })

  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!sessionGoalIsAccruing(props.goal)) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const elapsed = createMemo(() =>
    formatSessionGoalDuration(sessionGoalDisplayedSeconds(props.goal, observedAt(), now())),
  )
  const usage = createMemo(() => language.t("session.goal.elapsed", { elapsed: elapsed() }))
  const objectiveError = createMemo(() => sessionGoalObjectiveError(store.objective))

  const save = () => {
    if (objectiveError()) return
    props.onEdit({ objective: store.objective.trim() })
  }

  const reset = () => {
    setStore({
      objective: props.goal.objective,
      editing: false,
    })
  }

  return (
    <DockTray
      attach={props.attach ?? "bottom"}
      data-component="session-goal-dock"
      data-status={props.goal.status}
      data-rule={sessionGoalRuleTone(props.goal.status)}
    >
      <div class="flex min-h-10 items-center gap-2 px-3 py-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={store.expanded}
          onClick={() => setStore("expanded", (value) => !value)}
        >
          <span
            class="shrink-0 rounded-control bg-surface-raised-base px-2 py-0.5 text-12-medium text-text-strong"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {status()}
          </span>
          <span data-slot="session-goal-objective" class="min-w-0 flex-1 truncate text-13-regular text-text-base">
            {props.goal.objective}
          </span>
          <span data-slot="session-goal-usage" class="shrink-0 text-12-regular text-text-weak" aria-hidden="true">
            {usage()}
          </span>
        </button>
        <IconButton
          icon="chevron-down"
          size="normal"
          variant="ghost"
          style={{ transform: `rotate(${store.expanded ? 180 : 0}deg)` }}
          onClick={() => setStore("expanded", (value) => !value)}
          aria-label={language.t(store.expanded ? "session.goal.collapse" : "session.goal.expand")}
        />
      </div>

      <Show when={!store.expanded && (props.attach ?? "bottom") === "bottom"}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={store.expanded}>
        <div class="flex flex-col gap-3 px-3 pb-7">
          <Show
            when={store.editing}
            fallback={
              <p class="max-h-28 overflow-y-auto whitespace-pre-wrap text-13-regular text-text-strong">
                {props.goal.objective}
              </p>
            }
          >
            <label class="flex flex-col gap-1 text-12-medium text-text-base">
              {language.t("session.goal.objective")}
              <textarea
                data-action="session-goal-objective"
                class="min-h-20 w-full resize-y rounded-control border border-border-weak-base bg-background-base px-2.5 py-2 text-13-regular text-text-strong outline-none focus:border-border-strong-base"
                value={store.objective}
                maxlength={SESSION_GOAL_OBJECTIVE_MAX_LENGTH}
                aria-invalid={!!objectiveError()}
                onInput={(event) => setStore("objective", event.currentTarget.value)}
              />
            </label>
          </Show>

          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <Show
              when={store.editing}
              fallback={
                <>
                  <Show when={props.goal.status !== "complete"}>
                    <Button
                      data-action="session-goal-edit"
                      size="small"
                      variant="ghost"
                      disabled={props.disabled}
                      onClick={() => setStore("editing", true)}
                    >
                      {language.t("common.edit")}
                    </Button>
                  </Show>
                  <Show
                    when={props.goal.status === "active"}
                    fallback={
                      <Show when={props.goal.status !== "complete"}>
                        <Button
                          data-action="session-goal-resume"
                          size="small"
                          variant="secondary"
                          disabled={props.disabled}
                          onClick={props.onResume}
                        >
                          {language.t("session.goal.resume")}
                        </Button>
                      </Show>
                    }
                  >
                    <Button
                      data-action="session-goal-pause"
                      size="small"
                      variant="secondary"
                      disabled={props.disabled}
                      onClick={props.onPause}
                    >
                      {language.t("session.goal.pause")}
                    </Button>
                  </Show>
                  <Button
                    data-action="session-goal-clear"
                    size="small"
                    variant="ghost"
                    disabled={props.disabled}
                    onClick={props.onClear}
                  >
                    {language.t("common.clear")}
                  </Button>
                </>
              }
            >
              <Button size="small" variant="ghost" disabled={props.disabled} onClick={reset}>
                {language.t("common.cancel")}
              </Button>
              <Button
                data-action="session-goal-save"
                size="small"
                variant="secondary"
                disabled={props.disabled || !!objectiveError()}
                onClick={save}
              >
                {language.t("common.save")}
              </Button>
            </Show>
          </div>
        </div>
      </Show>
    </DockTray>
  )
}
