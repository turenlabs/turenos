import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Tag } from "@turenlabs/ui/v2/badge-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { ProviderIcon } from "@turenlabs/ui/provider-icon"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { shouldReauthenticateOnReconnect, useProviderConnection } from "@/hooks/use-provider-connection"
import { createMemo, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { SettingsListV2 } from "./parts/list"
import { SettingsServerPicker, SettingsServerScope } from "../settings-server-picker"
import { SettingsPageHeaderV2 } from "./page-header"
import "./settings-v2.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component<{ onBack?: () => void }> = (props) => {
  return (
    <SettingsServerScope>
      <SettingsProvidersContent {...props} />
    </SettingsServerScope>
  )
}

const SettingsProvidersContent: Component<{ onBack?: () => void }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders()
  const connection = useProviderConnection()
  const providerConnect = useProviderConnectController({ onBack: props.onBack })

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => <DialogConnectProvider controller={providerConnect} />)
  }

  const connected = createMemo(() => providers.connected())

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const excludedIDs = new Set(connection.excluded())
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id) && !excludedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync().data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disabled = createMemo(() => {
    const all = providers.all()
    return connection.excluded().map((id) => ({
      id,
      name: all.get(id)?.name ?? id,
    }))
  })

  const reconnect = (providerID: string) => {
    // OpenAI drops its ChatGPT OAuth credential on disconnect. xAI keeps its
    // credential so active sessions survive, so Connect must replace it rather
    // than merely making the stale one visible again.
    if (shouldReauthenticateOnReconnect(providerID)) {
      connect(providerID)
      return
    }
    void connection.reconnect(providerID)
  }

  return (
    <>
      <SettingsPageHeaderV2
        title={language.t("settings.providers.title")}
        description={language.t("settings.providers.description")}
        scope={language.t("settings.scope.selectedServer")}
        actions={<SettingsServerPicker />}
      />

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={connected()}>
                {(item) => (
                  <div class="settings-v2-provider-row group">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={item.id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name truncate">{item.name}</span>
                        <Tag>{type(item)}</Tag>
                      </div>
                    </div>
                    <Show
                      when={canDisconnect(item)}
                      fallback={
                        <span class="settings-v2-provider-env-hint">
                          {language.t("settings.providers.connected.environmentDescription")}
                        </span>
                      }
                    >
                      <ButtonV2
                        size="normal"
                        variant="ghost-muted"
                        onClick={() => void connection.disconnect(item.id, item.name)}
                      >
                        {language.t("common.disconnect")}
                      </ButtonV2>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <Show when={disabled().length > 0}>
          <div class="settings-v2-section" data-component="disabled-providers-section">
            <h3 class="settings-v2-section-title">{language.t("settings.providers.section.disabled")}</h3>
            <SettingsListV2>
              <For each={disabled()}>
                {(item) => (
                  <div class="settings-v2-provider-row">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={item.id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-copy">
                        <div class="settings-v2-provider-main">
                          <span class="settings-v2-provider-name truncate">{item.name}</span>
                        </div>
                        <p class="settings-v2-provider-description">
                          {language.t("settings.providers.disabled.description")}
                        </p>
                      </div>
                    </div>
                    <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => reconnect(item.id)}>
                      {language.t("common.connect")}
                    </ButtonV2>
                  </div>
                )}
              </For>
            </SettingsListV2>
          </div>
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={popular()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <div class="settings-v2-provider-row" data-component="custom-provider-section">
              <div class="settings-v2-provider-lead">
                <ProviderIcon
                  id="synthetic"
                  width={PROVIDER_ICON_SIZE}
                  height={PROVIDER_ICON_SIZE}
                  class="settings-v2-provider-icon shrink-0"
                />
                <div class="settings-v2-provider-copy">
                  <div class="settings-v2-provider-main">
                    <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                    <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                  </div>
                  <p class="settings-v2-provider-description">{language.t("settings.providers.custom.description")}</p>
                </div>
              </div>
              <ButtonV2
                size="normal"
                variant="neutral"
                icon="plus"
                onClick={() => {
                  const server = serverSDK().server
                  dialog.show(() => <DialogCustomProvider server={server} onBack={dialog.close} />)
                }}
              >
                {language.t("common.connect")}
              </ButtonV2>
            </div>
          </SettingsListV2>

          <button type="button" class="settings-v2-providers-view-all" onClick={() => connect()}>
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}
