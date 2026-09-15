import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Tag } from "@turenlabs/ui/v2/badge-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { ProviderIcon } from "@turenlabs/ui/provider-icon"
import { isLocalProvider, isLocalProviderID, localProviders } from "@/hooks/provider-visibility"
import { useProviders } from "@/hooks/use-providers"
import { useProviderConnection } from "@/hooks/use-provider-connection"
import { createMemo, createSignal, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { SettingsListV2 } from "./parts/list"
import { SettingsServerPicker, SettingsServerScope } from "../settings-server-picker"
import { SettingsPageHeaderV2 } from "./page-header"
import "./settings-v2.css"

type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_ICON_SIZE = 16

export const SettingsLocalProvidersV2: Component<{ onBack?: () => void }> = (props) => {
  return (
    <SettingsServerScope>
      <SettingsLocalProvidersContent {...props} />
    </SettingsServerScope>
  )
}

const SettingsLocalProvidersContent: Component<{ onBack?: () => void }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders()
  const connection = useProviderConnection()
  const providerConnect = useProviderConnectController({ onBack: props.onBack })
  const [removing, setRemoving] = createSignal("")

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => <DialogConnectProvider controller={providerConnect} />)
  }

  const configuredBaseURL = (id: string) => serverSync().data.config.provider?.[id]?.options?.baseURL

  const connected = createMemo(() => providers.connected().filter(isLocalProvider))
  const removedIDs = createMemo(
    () => new Set(connection.excluded().filter((id) => isLocalProviderID(id, configuredBaseURL(id)))),
  )

  const kind = (id: string) => localProviders.find((item) => item.id === id)?.kind ?? "server"
  const kindLabel = (id: string) =>
    language.t(kind(id) === "cli" ? "settings.localProviders.tag.cli" : "settings.localProviders.tag.server")

  const modelCount = (item: ProviderItem) => {
    const count = Object.keys(item.models).length
    return count === 1
      ? language.t("settings.localProviders.models.one", { count })
      : language.t("settings.localProviders.models.other", { count })
  }

  // Built-in local runtimes not currently set up. A removed one lands back here, so setup is the
  // restore path for anything `disabled_providers` is hiding.
  const available = createMemo(() =>
    localProviders.filter((item) => !connected().some((p) => p.id === item.id) && !removedIDs().has(item.id)),
  )

  // Config-defined local endpoints that exist in the catalog but are not connected right now
  // (for example a custom loopback server that is down).
  const offline = createMemo(() => {
    const known = new Set(localProviders.map((item) => item.id))
    return [...providers.all().values()].filter(
      (item) =>
        isLocalProvider(item) &&
        !connected().some((p) => p.id === item.id) &&
        !known.has(item.id) &&
        !removedIDs().has(item.id),
    )
  })

  const removed = createMemo(() => {
    const all = providers.all()
    return [...removedIDs()].map((id) => ({
      id,
      name: all.get(id)?.name ?? localProviders.find((item) => item.id === id)?.name ?? id,
    }))
  })

  const restore = async (id: string) => {
    await connection.enable(id)
    await connection.refresh()
  }

  return (
    <>
      <SettingsPageHeaderV2
        title={language.t("settings.localProviders.title")}
        description={language.t("settings.localProviders.description")}
        scope={language.t("settings.scope.selectedServer")}
        actions={<SettingsServerPicker />}
      />

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="local-providers-connected-section">
          <h3 class="settings-v2-section-title">{language.t("settings.localProviders.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.localProviders.connected.empty")}</div>
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
                        <Tag>{kindLabel(item.id)}</Tag>
                        <span class="settings-v2-provider-description">{modelCount(item)}</span>
                      </div>
                    </div>
                    <Show
                      when={removing() === item.id}
                      fallback={
                        <div class="flex items-center gap-2">
                          <ButtonV2
                            size="normal"
                            variant="ghost-muted"
                            icon="reset"
                            onClick={() => void connection.refresh()}
                            aria-label={language.t("common.refresh")}
                          />
                          <ButtonV2 size="normal" variant="ghost-muted" onClick={() => setRemoving(item.id)}>
                            {language.t("common.remove")}
                          </ButtonV2>
                        </div>
                      }
                    >
                      <div class="flex items-center gap-2">
                        <span class="settings-v2-provider-description">
                          {language.t("settings.localProviders.remove.confirm", { provider: item.name })}
                        </span>
                        <ButtonV2 size="normal" variant="neutral" onClick={() => setRemoving("")}>
                          {language.t("common.cancel")}
                        </ButtonV2>
                        <ButtonV2
                          size="normal"
                          variant="danger"
                          onClick={() => {
                            setRemoving("")
                            void connection.remove(item.id, item.name)
                          }}
                        >
                          {language.t("common.remove")}
                        </ButtonV2>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section" data-component="local-providers-available-section">
          <h3 class="settings-v2-section-title">{language.t("settings.localProviders.section.available")}</h3>
          <SettingsListV2>
            <For each={available()}>
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
                        <Tag>{kindLabel(item.id)}</Tag>
                      </div>
                      <p class="settings-v2-provider-description">{language.t(item.descriptionKey)}</p>
                    </div>
                  </div>
                  <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <For each={offline()}>
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
                        <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                      </div>
                      <p class="settings-v2-provider-description">
                        {language.t("settings.localProviders.offline.description")}
                      </p>
                    </div>
                  </div>
                  <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <div class="settings-v2-provider-row" data-component="custom-local-provider-section">
              <div class="settings-v2-provider-lead">
                <ProviderIcon
                  id="synthetic"
                  width={PROVIDER_ICON_SIZE}
                  height={PROVIDER_ICON_SIZE}
                  class="settings-v2-provider-icon shrink-0"
                />
                <div class="settings-v2-provider-copy">
                  <div class="settings-v2-provider-main">
                    <span class="settings-v2-provider-name">{language.t("settings.localProviders.custom.title")}</span>
                    <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                  </div>
                  <p class="settings-v2-provider-description">
                    {language.t("settings.localProviders.custom.description")}
                  </p>
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
        </div>

        <Show when={removed().length > 0}>
          <div class="settings-v2-section" data-component="local-providers-removed-section">
            <h3 class="settings-v2-section-title">{language.t("settings.localProviders.section.removed")}</h3>
            <SettingsListV2>
              <For each={removed()}>
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
                          {language.t("settings.localProviders.removed.description")}
                        </p>
                      </div>
                    </div>
                    <ButtonV2 size="normal" variant="neutral" onClick={() => void restore(item.id)}>
                      {language.t("common.restore")}
                    </ButtonV2>
                  </div>
                )}
              </For>
            </SettingsListV2>
          </div>
        </Show>
      </div>
    </>
  )
}
