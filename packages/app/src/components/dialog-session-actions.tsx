// Dialogs for the destructive/committing session row actions.
//
// Both dialogs own the pending state and only close once `submit` resolves.
// `submit` is expected to reject when the server did not apply the change (see
// pages/home-session-actions.ts), so a failure keeps the dialog open with the
// reason inline instead of closing on a change that never happened.

import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTitleGroup,
} from "@turenlabs/ui/v2/dialog-v2"
import { Field } from "@turenlabs/ui/v2/field-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"

export function DialogRenameSession(props: { title: string; submit: (title: string) => Promise<void> }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ title: props.title, pending: false, error: "" })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.pending) return
    const next = state.title.trim()
    if (!next || next === props.title.trim()) {
      dialog.close()
      return
    }
    setState({ pending: true, error: "" })
    try {
      await props.submit(next)
      dialog.close()
    } catch (err) {
      setState({ pending: false, error: errorMessage(err, language.t("session.rename.failed.title")) })
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("session.rename.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody class="flex w-full flex-col gap-3 px-4 pb-1 pt-4">
          <Field>
            <Field.Label>{language.t("session.rename.label")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              data-action="session-rename-input"
              value={state.title}
              disabled={state.pending}
              onInput={(event) => setState("title", event.currentTarget.value)}
            />
          </Field>
          <Show when={state.error}>
            <p data-slot="session-rename-error" class="text-[12px] font-[440] text-v2-text-text-danger">
              {state.error}
            </p>
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={state.pending} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={state.pending}>
            {state.pending ? language.t("common.saving") : language.t("common.save")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export function DialogDeleteSession(props: { name: string; submit: () => Promise<void> }) {
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
      setState({ pending: false, error: errorMessage(err, language.t("session.delete.failed.title")) })
    }
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.delete.title")}
          description={language.t("session.delete.confirm", { name: props.name })}
        />
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-3 px-4 pb-1 pt-1">
        <p class="text-[12px] font-[440] leading-[1.45] text-v2-text-text-muted">
          {language.t("session.delete.warning")}
        </p>
        <Show when={state.error}>
          <p data-slot="session-delete-error" class="text-[12px] font-[440] text-v2-text-text-danger">
            {state.error}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" disabled={state.pending} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 data-action="session-delete-confirm" variant="danger" disabled={state.pending} onClick={submit}>
          {language.t("session.delete.button")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
