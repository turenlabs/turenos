import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import type { ForgeClient } from "@turenlabs/sdk/v2/client"

export async function disconnectProvider(input: {
  providerID: string
  client: ForgeClient
  exclude: (providerID: string) => void
  refresh: () => Promise<unknown>
}) {
  await input.client.auth.remove({ providerID: input.providerID }, { throwOnError: true })
  input.exclude(input.providerID)
  // Once credentials are deleted, refresh the picker even if runtime disposal fails.
  await input.client.global.dispose({ throwOnError: true }).finally(input.refresh)
}

/**
 * Disconnect deletes stored credentials and retires cached provider clients.
 * Reconnecting must authenticate again; picker exclusion is not a substitute for logout.
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
    const sdk = serverSDK()
    const sync = serverSync()
    try {
      await disconnectProvider({
        providerID,
        client: sdk.client,
        exclude: sync.provider.exclude,
        refresh: sync.refreshProviders,
      })
      disconnected(name)
    } catch (err) {
      failed(err)
    }
  }

  // Remove deletes credentials and config entries and durably disables the provider. Built-in
  // providers stay restorable through their setup wizard; configured ones are gone until re-added.
  const remove = async (providerID: string, name: string) => {
    const sdk = serverSDK()
    const sync = serverSync()
    try {
      await sdk.client.provider.remove({ providerID }, { throwOnError: true })
      await sdk.client.global.dispose({ throwOnError: true }).finally(sync.refreshProviders)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.remove.toast.removed.title", { provider: name }),
        description: language.t("provider.remove.toast.removed.description", { provider: name }),
      })
    } catch (err) {
      failed(err)
    }
  }

  // Refresh disposes the runtime so the next provider read re-runs local probes and discovery.
  const refresh = async () => {
    const sdk = serverSDK()
    const sync = serverSync()
    await sdk.client.global.dispose().finally(sync.refreshProviders)
  }

  const excluded = () => [
    ...new Set([...(serverSync().data.config.disabled_providers ?? []), ...serverSync().provider.excluded()]),
  ]

  return { disconnect, enable, remove, refresh, excluded }
}
