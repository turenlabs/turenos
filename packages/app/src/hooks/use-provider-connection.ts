import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

export function shouldClearAuthOnDisconnect(providerID: string) {
  return providerID === "openai"
}

export function shouldReauthenticateOnReconnect(providerID: string) {
  return providerID === "openai" || providerID === "xai"
}

/**
 * Disconnect hides the provider from this server's picker. OpenAI also drops
 * its stored OAuth credential so Connect cannot reuse the previous ChatGPT
 * session. Other providers keep credentials so active runs are not torn down.
 */
export function useProviderConnection() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const failed = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const disconnected = (name: string) => {
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
      description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
    })
  }

  // Clear the old config-backed opt-out too. New disconnects never write it,
  // but existing installations may still have entries from earlier versions.
  const enable = async (providerID: string) => {
    const sync = serverSync()
    sync.provider.include(providerID)
    const current = sync.data.config.disabled_providers ?? []
    if (current.includes(providerID)) {
      await sync.updateConfig({ disabled_providers: current.filter((id) => id !== providerID) })
    }
  }

  const disconnect = async (providerID: string, name: string) => {
    try {
      if (shouldClearAuthOnDisconnect(providerID)) {
        await serverSDK().client.auth.remove({ providerID })
        await serverSDK().client.global.dispose()
        await serverSync().refreshProviders()
      }
      serverSync().provider.exclude(providerID)
      disconnected(name)
    } catch (err) {
      failed(err)
    }
  }

  const reconnect = async (providerID: string) => {
    try {
      await enable(providerID)
    } catch (err) {
      failed(err)
    }
  }

  const excluded = () => [
    ...new Set([...(serverSync().data.config.disabled_providers ?? []), ...serverSync().provider.excluded()]),
  ]

  return { disconnect, reconnect, enable, excluded }
}
