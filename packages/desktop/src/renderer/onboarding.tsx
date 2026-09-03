import { ServerConnection, useProviders, useServer, useSettings, useSettingsDialog, useTabs } from "@turenlabs/app"
import { Button } from "@turenlabs/ui/button"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { t } from "./i18n"
import { selectedOnboardingDirectory, shouldShowFirstLaunchOnboarding } from "./onboarding-model"

const steps = ["welcome", "provider", "workspace"] as const
type Step = (typeof steps)[number]

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string }) {
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()
  const providers = useProviders()
  const showProviderSettings = useSettingsDialog("providers")
  const [visible, setVisible] = createSignal(false)
  const [step, setStep] = createSignal<Step>("welcome")
  const [busy, setBusy] = createSignal(false)
  const connected = createMemo(() => providers.connected().length)
  const stepIndex = createMemo(() => steps.indexOf(step()))

  onMount(() => void evaluate())

  async function evaluate() {
    try {
      await Promise.all(
        [server.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map((p) => p ?? Promise.resolve()),
      )
      const existingInstall = await window.api.isOldLayoutEligible()
      settings.general.setOldLayoutEligible(existingInstall)
      const pending = server.isLocal() && (await window.api.isFirstLaunchOnboardingPending())

      console.info("[desktop-onboarding] first launch onboarding evaluated", {
        pending,
        existingInstall,
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        servers: server.list.map(ServerConnection.key),
      })

      setVisible(
        shouldShowFirstLaunchOnboarding({
          pending,
          local: server.isLocal(),
          initialUrl: props.initialUrl,
          tabs: tabs.store.length,
        }),
      )
    } catch (error) {
      console.error("[desktop-onboarding] first launch onboarding failed", error)
    }
  }

  async function complete() {
    setBusy(true)
    try {
      await window.api.finishFirstLaunchOnboarding()
      setVisible(false)
    } finally {
      setBusy(false)
    }
  }

  async function chooseWorkspace() {
    const directory = selectedOnboardingDirectory(
      await window.api.openDirectoryPicker({ title: t("desktop.onboarding.workspace.picker") }),
    )
    if (!directory) return
    setBusy(true)
    try {
      server.projects.open(directory)
      server.projects.touch(directory)
      tabs.select(await tabs.newDraft({ server: server.key, directory }))
      await window.api.finishFirstLaunchOnboarding()
      setVisible(false)
    } finally {
      setBusy(false)
    }
  }

  const next = () => setStep(steps[Math.min(stepIndex() + 1, steps.length - 1)])
  const back = () => setStep(steps[Math.max(stepIndex() - 1, 0)])

  return (
    <Show when={visible()}>
      <div class="desktop-onboarding" role="dialog" aria-modal="true" aria-labelledby="desktop-onboarding-title">
        <div class="desktop-onboarding-card">
          <aside class="desktop-onboarding-rail">
            <div class="desktop-onboarding-mark">T</div>
            <div class="desktop-onboarding-brand">TurenOS</div>
            <div class="desktop-onboarding-progress">
              <For each={steps}>
                {(item, index) => (
                  <div
                    classList={{
                      "desktop-onboarding-step": true,
                      active: step() === item,
                      complete: stepIndex() > index(),
                    }}
                  >
                    <span>{String(index() + 1).padStart(2, "0")}</span>
                    <strong>{t(`desktop.onboarding.step.${item}`)}</strong>
                  </div>
                )}
              </For>
            </div>
            <p>{t("desktop.onboarding.local")}</p>
          </aside>

          <main class="desktop-onboarding-content">
            <div class="desktop-onboarding-counter">
              {stepIndex() + 1} / {steps.length}
            </div>
            <Show when={step() === "welcome"}>
              <section>
                <span class="desktop-onboarding-kicker">{t("desktop.onboarding.welcome.kicker")}</span>
                <h1 id="desktop-onboarding-title">{t("desktop.onboarding.welcome.title")}</h1>
                <p>{t("desktop.onboarding.welcome.body")}</p>
                <div class="desktop-onboarding-preview">
                  <span>01</span>
                  <div>
                    <strong>{t("desktop.onboarding.provider.title")}</strong>
                    <small>{t("desktop.onboarding.welcome.provider")}</small>
                  </div>
                  <span>02</span>
                  <div>
                    <strong>{t("desktop.onboarding.workspace.title")}</strong>
                    <small>{t("desktop.onboarding.welcome.workspace")}</small>
                  </div>
                  <span>03</span>
                  <div>
                    <strong>{t("desktop.onboarding.session.title")}</strong>
                    <small>{t("desktop.onboarding.welcome.session")}</small>
                  </div>
                </div>
              </section>
            </Show>

            <Show when={step() === "provider"}>
              <section>
                <span class="desktop-onboarding-kicker">{t("desktop.onboarding.provider.kicker")}</span>
                <h1 id="desktop-onboarding-title">{t("desktop.onboarding.provider.title")}</h1>
                <p>{t("desktop.onboarding.provider.body")}</p>
                <div classList={{ "desktop-onboarding-status": true, connected: connected() > 0 }}>
                  <span />
                  <div>
                    <strong>
                      {connected() > 0
                        ? t("desktop.onboarding.provider.ready")
                        : t("desktop.onboarding.provider.empty")}
                    </strong>
                    <small>
                      {connected() > 0
                        ? t("desktop.onboarding.provider.readyHint", { count: connected() })
                        : t("desktop.onboarding.provider.emptyHint")}
                    </small>
                  </div>
                </div>
                <Button size="large" variant="secondary" icon="plus-small" onClick={showProviderSettings}>
                  {t("desktop.onboarding.provider.action")}
                </Button>
              </section>
            </Show>

            <Show when={step() === "workspace"}>
              <section>
                <span class="desktop-onboarding-kicker">{t("desktop.onboarding.workspace.kicker")}</span>
                <h1 id="desktop-onboarding-title">{t("desktop.onboarding.workspace.title")}</h1>
                <p>{t("desktop.onboarding.workspace.body")}</p>
                <div class="desktop-onboarding-session-tip">
                  <span>⌘</span>
                  <div>
                    <strong>{t("desktop.onboarding.session.title")}</strong>
                    <small>{t("desktop.onboarding.session.body")}</small>
                  </div>
                </div>
              </section>
            </Show>

            <footer class="desktop-onboarding-actions">
              <Button variant="ghost" disabled={busy()} onClick={() => void complete()}>
                {t("desktop.onboarding.skip")}
              </Button>
              <div>
                <Show when={stepIndex() > 0}>
                  <Button variant="ghost" disabled={busy()} onClick={back}>
                    {t("desktop.onboarding.back")}
                  </Button>
                </Show>
                <Show
                  when={step() !== "workspace"}
                  fallback={
                    <Button size="large" disabled={busy()} onClick={() => void chooseWorkspace()}>
                      {t("desktop.onboarding.start")}
                    </Button>
                  }
                >
                  <Button size="large" disabled={busy()} onClick={next}>
                    {t("desktop.onboarding.continue")}
                  </Button>
                </Show>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </Show>
  )
}
