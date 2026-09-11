import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@turenlabs/ui/v2/dialog-v2"
import { DividerV2 } from "@turenlabs/ui/v2/divider-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { type Component, Show, createEffect, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSshServers } from "./context"
import type { SshPrompt } from "./types"
import "../components/settings-v2/settings-v2.css"

/**
 * Global host for interactive ssh prompts (password, key passphrase,
 * host-key confirmation). The desktop main process surfaces them via
 * `sshServers.state.prompt`; answering routes back through
 * `respondPrompt`. Mounted once under SharedProviders so reconnects can
 * prompt anywhere in the app, not just while the settings dialog is open.
 */
export function SshPromptHost() {
  const ssh = useSshServers()
  const platform = usePlatform()
  const dialog = useDialog()
  let pushed = false

  createEffect(() => {
    const prompt = ssh.data?.prompt
    if (prompt && !pushed) {
      pushed = true
      dialog.push(() => <SshPromptDialog />, () => {
        // Closing without answering cancels the pending ssh invocation.
        const pending = ssh.data?.prompt
        if (pending) void platform.sshServers?.respondPrompt(pending.requestId, null)
      })
      return
    }
    if (!prompt && pushed) {
      pushed = false
      dialog.close()
    }
  })

  return null
}

const SshPromptDialog: Component = () => {
  const ssh = useSshServers()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal("")

  const prompt = () => ssh.data?.prompt

  const title = () => {
    const kind = prompt()?.kind
    if (kind === "hostkey") return language.t("ssh.prompt.hostkey.title")
    if (kind === "passphrase") return language.t("ssh.prompt.passphrase.title")
    return language.t("ssh.prompt.password.title")
  }

  const secret = () => prompt()?.kind === "password" || prompt()?.kind === "passphrase"

  const respond = (response: string | null) => {
    const pending = prompt()
    if (pending) void platform.sshServers?.respondPrompt(pending.requestId, response)
    dialog.close()
  }

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    respond(secret() ? value() : "yes")
  }

  return (
    <Show when={prompt()}>
      {(p: () => SshPrompt) => (
        <Dialog fit class="settings-v2-server-dialog">
          <DialogHeader hideClose={true}>
            <DialogTitle>{title()}</DialogTitle>
          </DialogHeader>
          <DividerV2 />
          <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
            <div class="flex w-full min-w-0 flex-col gap-4">
              <pre class="text-v2-text-text-muted max-h-40 overflow-auto text-xs whitespace-pre-wrap">
                {p().message}
              </pre>
              <Show when={secret()}>
                <TextInputV2
                  type="password"
                  appearance="large"
                  class="!w-full self-stretch"
                  value={value()}
                  placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                  autofocus
                  onInput={(event) => setValue(event.currentTarget.value)}
                  onKeyDown={keyDown}
                />
              </Show>
            </div>
          </DialogBody>
          <DialogFooter>
            <ButtonV2 variant="neutral" onClick={() => respond(null)}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 variant="contrast" onClick={() => respond(secret() ? value() : "yes")}>
              {p().kind === "hostkey" ? language.t("ssh.prompt.trust") : language.t("ssh.prompt.submit")}
            </ButtonV2>
          </DialogFooter>
        </Dialog>
      )}
    </Show>
  )
}
