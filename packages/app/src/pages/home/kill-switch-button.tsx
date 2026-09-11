import { createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@turenlabs/ui/v2/dialog-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import { killRunningAgents } from "../home-kill-switch"

export function KillSwitchButton(props: { class?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const global = useGlobal()
  const [killing, setKilling] = createSignal(false)

  async function activate() {
    if (killing()) return
    setKilling(true)
    try {
      await killRunningAgents(global.servers.list().map((conn) => global.ensureServerCtx(conn).sdk.client.v2.session))
      showToast({
        title: language.t("home.killSwitch.success"),
        description: language.t("home.killSwitch.success.description"),
        variant: "success",
      })
    } finally {
      setKilling(false)
    }
  }

  return (
    <ButtonV2
      data-action="home-kill-switch"
      variant="danger"
      size="normal"
      class={props.class}
      disabled={killing()}
      onClick={() => dialog.show(() => <DialogKillSwitch submit={activate} />, undefined, () => !killing())}
    >
      {language.t("home.killSwitch")}
    </ButtonV2>
  )
}

function DialogKillSwitch(props: { submit: () => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false, error: "" })
  const mounted = { value: true }
  onCleanup(() => (mounted.value = false))

  async function submit() {
    if (state.pending) return
    setState({ pending: true, error: "" })
    try {
      await props.submit()
      if (mounted.value) dialog.close()
    } catch (error) {
      if (!mounted.value) return
      setState({
        pending: false,
        error: errorMessage(error, language.t("home.killSwitch.failed")),
      })
    }
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("home.killSwitch.confirm.title")}
          description={language.t("home.killSwitch.confirm.description")}
        />
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-3 px-4 pb-1 pt-1">
        <Show when={state.error}>
          <p data-slot="home-kill-switch-error" role="alert" class="text-[12px] font-[440] text-v2-text-text-danger">
            {state.error}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" disabled={state.pending} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          data-action="home-kill-switch-confirm"
          variant="danger"
          disabled={state.pending}
          onClick={() => void submit()}
        >
          {state.pending ? language.t("home.killSwitch.pending") : language.t("home.killSwitch.confirm.action")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
