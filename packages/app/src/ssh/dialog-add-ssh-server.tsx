import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@turenlabs/ui/v2/dialog-v2"
import { DividerV2 } from "@turenlabs/ui/v2/divider-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { type Component, Show, createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { useSshServers } from "./context"
import type { SshServerConfig } from "./types"
import "../components/settings-v2/settings-v2.css"

export const DialogAddSshServer: Component<{
  onAdded?: (config: SshServerConfig) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const ssh = useSshServers()
  const api = platform.sshServers

  const [store, setStore] = createStore({
    host: "",
    port: "",
    identityFile: "",
    name: "",
    connectingId: undefined as string | undefined,
    error: "",
  })

  const target = createMemo(() => {
    const host = store.host.trim()
    if (!host || /\s/.test(host) || host.startsWith("-")) return null
    const port = store.port.trim() ? Number(store.port.trim()) : null
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null
    return {
      host,
      port,
      identityFile: store.identityFile.trim() || null,
      displayName: store.name.trim() || null,
    }
  })

  const connecting = createMemo(() => {
    const id = store.connectingId
    if (!id) return undefined
    return ssh.data?.servers.find((item) => item.config.id === id)
  })

  createEffect(() => {
    const runtime = connecting()?.runtime
    const config = connecting()?.config
    if (!runtime || !config) return
    if (runtime.kind === "ready") {
      dialog.close()
      void props.onAdded?.(config)
    }
    if (runtime.kind === "failed") {
      setStore({ connectingId: undefined, error: runtime.message })
    }
  })

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    submit()
  }

  const submit = async () => {
    const value = target()
    if (!value || store.connectingId || !api) return
    setStore("error", "")
    try {
      const config = await api.addServer(value)
      setStore("connectingId", config.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStore("error", message)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
    }
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("ssh.dialog.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <p class="text-v2-text-text-muted text-xs">{language.t("ssh.dialog.description")}</p>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("ssh.dialog.host")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={store.host}
              placeholder={language.t("ssh.dialog.hostPlaceholder")}
              invalid={!!store.error}
              disabled={!!store.connectingId}
              autofocus
              onInput={(event) => setStore({ host: event.currentTarget.value, error: "" })}
              onKeyDown={keyDown}
            />
            <Show when={store.error}>
              <span class="settings-v2-server-dialog-error">{store.error}</span>
            </Show>
          </div>
          <div class="grid w-full min-w-0 grid-cols-2 gap-4">
            <div class="flex min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("ssh.dialog.port")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={store.port}
                placeholder="22"
                disabled={!!store.connectingId}
                onInput={(event) => setStore({ port: event.currentTarget.value, error: "" })}
                onKeyDown={keyDown}
              />
            </div>
            <div class="flex min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("ssh.dialog.identityFile")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={store.identityFile}
                placeholder="~/.ssh/id_ed25519"
                disabled={!!store.connectingId}
                onInput={(event) => setStore({ identityFile: event.currentTarget.value, error: "" })}
                onKeyDown={keyDown}
              />
            </div>
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={store.name}
              placeholder={language.t("ssh.dialog.namePlaceholder")}
              disabled={!!store.connectingId}
              onInput={(event) => setStore({ name: event.currentTarget.value, error: "" })}
              onKeyDown={keyDown}
            />
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={!!store.connectingId} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!target() || !!store.connectingId} onClick={() => void submit()}>
          {store.connectingId ? language.t("ssh.dialog.connecting") : language.t("ssh.dialog.connect")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
