import type { McpRuntimeBackendStatus, McpRuntimeStatus } from "@turenlabs/sdk/v2/client"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Tag } from "@turenlabs/ui/v2/badge-v2"
import { type Component, For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsListV2 } from "./parts/list"
import { mcpRuntimeAction, mcpRuntimeBackendName, type McpRuntimeAction } from "./mcp-runtime-model"
import "./settings-v2.css"

const checkedAt = (backend: McpRuntimeBackendStatus) =>
  backend.checkedAt && backend.checkedAt > 0 ? new Date(backend.checkedAt).toLocaleString() : "Not tested"

export const SettingsMcpRuntimeV2: Component<{ embedded?: boolean }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const [pending, setPending] = createSignal<McpRuntimeAction | undefined>()
  const [error, setError] = createSignal<string>()
  let request: AbortController | undefined
  const [runtime, { mutate, refetch }] = createResource(serverSdk, async (sdk) => ({
    sdk,
    value: (await sdk.client.security.mcpRuntime.get({ throwOnError: true })).data,
  }))
  const value = createMemo(() => (runtime.latest?.sdk === serverSdk() ? runtime.latest.value : undefined))

  createEffect(() => {
    serverSdk()
    request?.abort()
    request = undefined
    setPending(undefined)
    setError(undefined)
  })
  onCleanup(() => request?.abort())

  const apply = (action: McpRuntimeAction, execute: (signal: AbortSignal) => Promise<McpRuntimeStatus | undefined>) => {
    if (pending()) return
    const sdk = serverSdk()
    const next = new AbortController()
    request?.abort()
    request = next
    setPending(action)
    setError(undefined)
    void execute(next.signal)
      .then((result) => {
        if (sdk !== serverSdk() || next.signal.aborted || !result) return
        mutate({ sdk, value: result })
      })
      .catch((cause) => {
        if (sdk !== serverSdk() || next.signal.aborted) return
        setError(cause instanceof Error ? cause.message : language.t("settings.mcpRuntime.error"))
      })
      .finally(() => {
        if (request !== next) return
        request = undefined
        setPending(undefined)
      })
  }

  const select = (backend: "docker" | "local") =>
    apply("select", (signal) =>
      serverSdk()
        .client.security.mcpRuntime.update({ mcpRuntimeSettingsInput: { backend } }, { signal, throwOnError: true })
        .then((result) => result.data),
    )

  const test = () =>
    apply("test", (signal) =>
      serverSdk()
        .client.security.mcpRuntime.test({ signal, throwOnError: true })
        .then((result) => result.data),
    )

  const RuntimeContent = () => (
    <>
      <p class="settings-v2-section-note" data-rule="notch">
        {language.t("settings.mcpRuntime.intro")}
      </p>
      <Show when={error()}>
        {(message) => (
          <p role="alert" class="settings-v2-mcp-runtime-error">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={value()}
        fallback={<p class="settings-v2-mcp-runtime-muted">{language.t("settings.mcpRuntime.loading")}</p>}
      >
        {(state) => (
          <SettingsListV2>
            <For each={state().backends}>
              {(backend) => {
                const action = () => mcpRuntimeAction(backend)
                const selected = () => backend.selected
                return (
                  <section class="settings-v2-mcp-runtime-card" data-backend={backend.backend}>
                    <div class="settings-v2-mcp-runtime-heading">
                      <div>
                        <div class="settings-v2-mcp-runtime-title">
                          <strong>{mcpRuntimeBackendName(backend)}</strong>
                          <Show when={backend.backend === "docker"}>
                            <Tag>{language.t("settings.mcpRuntime.recommended")}</Tag>
                          </Show>
                          <Tag>{backend.status}</Tag>
                          <Show when={selected()}>
                            <Tag>{language.t("settings.mcpRuntime.selected")}</Tag>
                          </Show>
                        </div>
                        <p>{backend.detail}</p>
                      </div>
                      <Show when={action() !== "unavailable"}>
                        <div class="settings-v2-mcp-runtime-actions">
                          <ButtonV2
                            size="normal"
                            variant={selected() ? "ghost-muted" : "neutral"}
                            disabled={pending() !== undefined || selected()}
                            onClick={() => select(backend.backend as "docker" | "local")}
                          >
                            {selected()
                              ? language.t("settings.mcpRuntime.active")
                              : language.t("settings.mcpRuntime.select")}
                          </ButtonV2>
                          <Show when={action() === "test"}>
                            <ButtonV2
                              size="normal"
                              variant="ghost-muted"
                              disabled={pending() !== undefined}
                              onClick={test}
                            >
                              {pending() === "test"
                                ? language.t("settings.mcpRuntime.testing")
                                : language.t("settings.mcpRuntime.test")}
                            </ButtonV2>
                          </Show>
                        </div>
                      </Show>
                    </div>
                    <div class="settings-v2-mcp-runtime-meta">
                      <span>
                        {language.t("settings.mcpRuntime.checked")}: {checkedAt(backend)}
                      </span>
                      <Show when={backend.version}>
                        {(version) => (
                          <span>
                            {language.t("settings.mcpRuntime.version")}: {version()}
                          </span>
                        )}
                      </Show>
                      <Show when={backend.revision !== undefined}>
                        <span>
                          {language.t("settings.mcpRuntime.revision")}: {backend.revision}
                        </span>
                      </Show>
                    </div>
                    <p class="settings-v2-mcp-runtime-network">{backend.networkPosture}</p>
                    <Show when={backend.capabilities.length > 0}>
                      <div class="settings-v2-mcp-runtime-capabilities">
                        <For each={backend.capabilities}>{(capability) => <code>{capability}</code>}</For>
                      </div>
                    </Show>
                  </section>
                )
              }}
            </For>
          </SettingsListV2>
        )}
      </Show>
      <button type="button" class="settings-v2-providers-view-all" onClick={() => void refetch()}>
        {language.t("settings.mcpRuntime.refresh")}
      </button>
    </>
  )

  if (props.embedded) {
    return (
      <div class="settings-v2-section settings-v2-mcp-runtime">
        <h3 class="settings-v2-section-title">{language.t("settings.mcpRuntime.title")}</h3>
        <RuntimeContent />
      </div>
    )
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.mcpRuntime.title")}</h2>
      </div>
      <div class="settings-v2-tab-body settings-v2-mcp-runtime">
        <RuntimeContent />
      </div>
    </>
  )
}
