import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { TranslationKey } from "@/context/language"
import { dailyTip, localDay, tips } from "./daily-tips"
import { readTipPreferences, writeTipPreference, type TipStore } from "./tip-preferences"

export function DailyTips(props: {
  storage: TipStore
  translate: (key: TranslationKey) => string
  date?: Date
  openTips: () => void
  onSaveFailed: () => void
}) {
  const date = props.date ?? new Date()
  const today = localDay(date)
  const tip = dailyTip(date)
  const [state, setState] = createStore({
    ready: false,
    valid: false,
    enabled: false,
    hiddenDay: undefined as string | undefined,
    saving: false,
  })
  let revision = 0
  let unsaved = false

  function refresh() {
    if (state.saving || unsaved) return
    const current = ++revision
    void readTipPreferences(props.storage, today).then((value) => {
      if (current !== revision || unsaved) return
      setState({ ready: true, valid: !!value, enabled: value?.enabled ?? false, hiddenDay: value?.hiddenDay })
    })
  }

  onMount(() => {
    refresh()
    window.addEventListener("focus", refresh)
    onCleanup(() => window.removeEventListener("focus", refresh))
  })

  async function hide() {
    if (state.saving) return
    revision += 1
    setState({ hiddenDay: today, saving: true })
    const saved = await writeTipPreference(props.storage, "daily-tips.hiddenDay", today)
    setState("saving", false)
    if (saved) return
    unsaved = true
    props.onSaveFailed()
  }

  async function toggle() {
    if (state.saving) return
    const enabled = !state.enabled
    const repair = enabled && !state.valid
    revision += 1
    setState({ enabled, valid: state.valid || repair, hiddenDay: repair ? undefined : state.hiddenDay, saving: true })
    const saved = repair
      ? await Promise.all([
          writeTipPreference(props.storage, "daily-tips.enabled", "true"),
          writeTipPreference(props.storage, "daily-tips.hiddenDay", null),
        ]).then((values) => values.every(Boolean))
      : await writeTipPreference(props.storage, "daily-tips.enabled", String(enabled))
    setState("saving", false)
    if (saved) return
    unsaved = true
    props.onSaveFailed()
  }

  return (
    <div data-component="tips" class="mt-4 flex min-w-0 flex-col items-center gap-2 text-v2-text-text-muted">
      <Show when={state.ready && state.valid && state.enabled && state.hiddenDay !== today}>
        <div
          data-component="daily-tip"
          class="w-full rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-2.5 text-left"
        >
          <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div class="min-w-0 flex-1">
              <div class="text-[11px] text-v2-text-text-faint">{props.translate("tips.label")}</div>
              <strong class="text-[13px] text-v2-text-text-base">{props.translate(tip.title)}</strong>
              <p class="text-[12px] leading-5">{props.translate(tip.body)}</p>
            </div>
            <button
              type="button"
              class="shrink-0 rounded px-1 text-[12px] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
              disabled={state.saving}
              onClick={() => void hide()}
            >
              {props.translate("tips.hideToday")}
            </button>
          </div>
        </div>
      </Show>
      <div class="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px]">
        <button type="button" class="hover:underline focus-visible:underline" onClick={props.openTips}>
          {props.translate("tips.browse")}
        </button>
        <Show when={state.ready}>
          <button
            type="button"
            class="hover:underline focus-visible:underline"
            disabled={state.saving}
            onClick={() => void toggle()}
          >
            {props.translate(state.enabled ? "tips.disable" : "tips.enable")}
          </button>
        </Show>
      </div>
    </div>
  )
}

export function TipCatalog(props: { translate: (key: TranslationKey) => string }) {
  return (
    <ul class="flex flex-col gap-3">
      <For each={tips}>
        {(tip) => (
          <li class="rounded-lg border border-v2-border-border-muted px-4 py-3">
            <strong class="text-[13px] text-v2-text-text-base">{props.translate(tip.title)}</strong>
            <p class="mt-1 text-[12px] leading-5 text-v2-text-text-muted">{props.translate(tip.body)}</p>
          </li>
        )}
      </For>
    </ul>
  )
}
