import { Button } from "@turenlabs/ui/button"
import { ProviderIcon } from "@turenlabs/ui/provider-icon"
import { Spinner } from "@turenlabs/ui/spinner"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { createEffect, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/components/link"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviderConnection } from "@/hooks/use-provider-connection"
import { showToast } from "@/utils/toast"
import { createAcpLoginController, type AcpLoginView } from "@turenlabs/client/acp-login"

export function AntigravityAcpConnection(props: { onBack: () => void; setBack: (handler: () => void) => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const connection = useProviderConnection()
  const [state, setState] = createStore<AcpLoginView>({ phase: "idle" })
  const control = { current: undefined as ReturnType<typeof createAcpLoginController> | undefined }
  const focus = { button: undefined as HTMLButtonElement | undefined }
  const pending = () => ["starting", "waiting", "finishing", "cancelling"].includes(state.phase)
  const provider = "Antigravity ACP (local)"

  createEffect(() => {
    const sdk = serverSDK()
    const sync = serverSync()
    const controller = untrack(() =>
      createAcpLoginController({
        authorize: async () => {
          const response = await sdk.client.provider.acp.authorize({}, { throwOnError: true })
          if (!response.data) throw new Error("Missing ACP authorization state")
          return response.data
        },
        status: async (id, signal) => {
          const response = await sdk.client.provider.acp.status({ id }, { signal, throwOnError: true })
          if (!response.data) throw new Error("Missing ACP authorization state")
          return response.data
        },
        cancel: (id) => sdk.client.provider.acp.cancel({ id }, { throwOnError: true }),
        complete: async () => {
          await connection.enable("antigravity-acp")
          await sdk.client.global.dispose({ throwOnError: true })
          await sync.refreshProviders()
        },
        onAuthenticated: () => {
          dialog.close()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.connect.toast.connected.title", { provider }),
            description: language.t("provider.connect.toast.connected.description", { provider }),
          })
        },
        onState: (next) => {
          setState({ phase: next.phase, url: next.url, error: next.error })
          if (next.phase === "cancelled" || next.phase === "error") focus.button?.focus()
        },
        failure: language.t("provider.connect.antigravity.failed"),
        cancellationFailure: language.t("provider.connect.antigravity.cancelFailed"),
      }),
    )
    control.current = controller
    setState({ phase: "idle", url: undefined, error: undefined })
    onCleanup(() => {
      controller.dispose()
      if (control.current === controller) control.current = undefined
    })
  })

  props.setBack(() => {
    control.current?.dispose()
    props.onBack()
  })

  const status = () => {
    if (state.phase === "starting") return language.t("provider.connect.antigravity.starting")
    if (state.phase === "waiting") return language.t("provider.connect.antigravity.waiting")
    if (state.phase === "finishing") return language.t("provider.connect.antigravity.finishing")
    if (state.phase === "cancelling") return language.t("provider.connect.antigravity.cancelling")
    if (state.phase === "cancelled") return language.t("provider.connect.antigravity.cancelled")
    return ""
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3" data-component="antigravity-acp-login">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id="antigravity-acp" aria-hidden="true" class="size-5 shrink-0 icon-strong-base" />
        <h2 class="text-16-medium text-text-strong">{language.t("provider.connect.title", { provider })}</h2>
      </div>
      <div class="px-2.5 pb-10 flex flex-col items-start gap-4">
        <p class="text-14-regular text-text-base">{language.t("provider.connect.antigravity.description")}</p>
        <p class="text-14-regular text-text-base">{language.t("provider.connect.antigravity.installation")}</p>
        <div role="status" aria-live="polite" class="text-14-regular text-text-base flex items-center gap-3">
          <Show when={pending()}>
            <span aria-hidden="true">
              <Spinner />
            </span>
          </Show>
          <span>{status()}</span>
        </div>
        <Show when={state.url}>
          {(url) => <Link href={url()}>{language.t("provider.connect.antigravity.openBrowser")}</Link>}
        </Show>
        <div role="alert" class="text-14-regular text-text-base">
          {state.error ?? ""}
        </div>
        <div class="flex flex-wrap gap-3">
          <Button
            ref={(element: HTMLButtonElement) => (focus.button = element)}
            autofocus
            size="large"
            variant="primary"
            disabled={pending()}
            onClick={() => void control.current?.start()}
          >
            {language.t("provider.connect.antigravity.signIn")}
          </Button>
          <Show when={pending() && state.phase !== "finishing"}>
            <Button
              size="large"
              variant="secondary"
              disabled={state.phase === "cancelling"}
              onClick={() => void control.current?.cancel()}
            >
              {language.t("common.cancel")}
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}
