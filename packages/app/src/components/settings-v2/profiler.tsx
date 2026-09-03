import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Switch } from "@turenlabs/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { ProfilerResult, ProfilerStatus } from "@/profiler"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

/**
 * Dev-only CPU profiler control.
 *
 * The scope line is not decoration. A run captures the TurenOS server process and
 * nothing else, and if the UI does not say that, someone will record a profile
 * looking for UI jank and find a file that never contained any.
 */

const TICK_MS = 1000

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function SettingsProfilerSection() {
  const language = useLanguage()
  const platform = usePlatform()

  const [status, setStatus] = createSignal<ProfilerStatus | undefined>()
  const [result, setResult] = createSignal<ProfilerResult | undefined>()
  const [failure, setFailure] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const running = createMemo(() => status()?.running === true)
  const available = createMemo(() => status()?.available === true)

  onMount(() => {
    const api = platform.profiler
    if (!api) return
    void api.status().then(setStatus, () => undefined)
    onCleanup(api.subscribe(setStatus))

    // Only ticks while a run is armed; a disarmed profiler costs the UI nothing.
    const timer = setInterval(() => {
      if (running()) setNow(Date.now())
    }, TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const elapsed = createMemo(() => {
    const startedAt = status()?.startedAt
    if (!startedAt) return 0
    return Math.max(0, now() - startedAt)
  })

  const toggle = async (checked: boolean) => {
    const api = platform.profiler
    if (!api || busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      if (checked) {
        setResult(undefined)
        setStatus(await api.start())
        setNow(Date.now())
      } else {
        setResult(await api.stop())
        setStatus(await api.status())
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      setStatus(await api.status().catch(() => undefined))
    } finally {
      setBusy(false)
    }
  }

  const reveal = () => {
    const directory = result()?.directory
    if (!directory || !platform.revealPath) return
    void platform.revealPath(directory)
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.profiler")}</h3>

      <p class="settings-v2-profiler-scope" data-rule="notch">
        {language.t("settings.general.profiler.scope")}
      </p>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.profiler.title")}
          description={
            <Show when={available()} fallback={language.t("settings.general.profiler.unavailable")}>
              <Show when={running()} fallback={language.t("settings.general.row.profiler.description")}>
                {language.t("settings.general.profiler.recording", {
                  elapsed: formatDuration(elapsed()),
                })}
              </Show>
            </Show>
          }
        >
          <div data-action="settings-profiler">
            <Switch
              checked={running()}
              disabled={busy() || !available()}
              onChange={(checked) => void toggle(checked)}
            />
          </div>
        </SettingsRowV2>

        <Show when={failure()}>
          {(message) => (
            <SettingsRowV2 title={language.t("settings.general.profiler.failedTitle")} description={message()}>
              <span />
            </SettingsRowV2>
          )}
        </Show>

        <Show when={result()}>
          {(profile) => (
            <SettingsRowV2
              title={language.t("settings.general.row.profilerResult.title")}
              description={
                <>
                  <span class="settings-v2-profiler-path">{profile().directory}</span>
                  <br />
                  {language.t("settings.general.row.profilerResult.description", {
                    samples: String(profile().samples),
                    rate: String(profile().sampleRateHz),
                    duration: formatDuration(profile().durationMs),
                  })}
                </>
              }
            >
              <Show when={platform.revealPath}>
                <ButtonV2 data-action="settings-profiler-reveal" size="normal" variant="neutral" onClick={reveal}>
                  {language.t("settings.general.profiler.reveal")}
                </ButtonV2>
              </Show>
            </SettingsRowV2>
          )}
        </Show>
      </SettingsListV2>
    </div>
  )
}
