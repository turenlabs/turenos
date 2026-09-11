import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@turenlabs/ui/v2/dialog-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"

export function DialogRemoveServer(props: {
  name: string
  /** Managed (wsl/ssh) servers also stop the remote/distro server process */
  managed?: boolean
  submit: () => Promise<void>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ pending: false, error: "" })

  const submit = async () => {
    if (state.pending) return
    setState({ pending: true, error: "" })
    try {
      await props.submit()
      dialog.close()
    } catch (err) {
      setState({ pending: false, error: errorMessage(err, language.t("dialog.server.remove.failed")) })
    }
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("dialog.server.remove.title")}
          description={language.t("dialog.server.remove.confirm", { name: props.name })}
        />
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-3 px-4 pb-1 pt-1">
        <p class="text-[12px] font-[440] leading-[1.45] text-v2-text-text-muted">
          {language.t(props.managed ? "dialog.server.remove.warningManaged" : "dialog.server.remove.warning")}
        </p>
        <Show when={state.error}>
          <p class="text-[12px] font-[440] text-v2-text-text-danger">{state.error}</p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" disabled={state.pending} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="danger" disabled={state.pending} onClick={submit}>
          {language.t("dialog.server.remove.button")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
