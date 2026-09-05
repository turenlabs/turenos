import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { promptAdmissionFor } from "./prompt-admission"

export function PromptAdmissionStatus(props: { sessionID: string; messageID: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const admission = promptAdmissionFor(usePlatform())
  let controller = new AbortController()
  createEffect(() => {
    sdk().scope
    props.sessionID
    props.messageID
    controller = new AbortController()
    const current = controller
    onCleanup(() => current.abort())
  })
  const entry = createMemo(() => admission.get(sdk().scope, props.sessionID, props.messageID))
  const pending = () =>
    admission.sending(sdk().scope, props.sessionID, props.messageID) ||
    admission.checking(sdk().scope, props.sessionID, props.messageID)
  const retry = () => {
    const current = entry()
    const client = sdk().client
    if (!current || pending()) return
    void admission.send(current, client, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return
      showToast({
        title: language.t("session.message.delivery.saveFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }
  const check = () => {
    const current = entry()
    if (!current || pending()) return
    void admission
      .check(current.scope, current.sessionID, current.payload.id, sdk().client, controller.signal)
      .catch(() => undefined)
  }
  return (
    <Show when={entry()?.state !== "admitted" && entry()}>
      {(current) => (
        <div
          data-slot="session-prompt-admission"
          class="pt-2 text-[12px] leading-4 text-v2-text-text-muted"
          role="status"
        >
          <div>
            {language.t(
              admission.sending(sdk().scope, props.sessionID, props.messageID)
                ? "session.message.delivery.sending"
                : pending()
                  ? "session.message.delivery.checking"
                  : current().state === "rejected"
                    ? "session.message.delivery.rejected"
                    : "session.message.delivery.unknown",
            )}
          </div>
          <Show when={current().state === "rejected" && current().error}>
            {(error) => <div class="pt-1 whitespace-pre-wrap break-words">{error()}</div>}
          </Show>
          <div class="flex gap-2 pt-1">
            <ButtonV2 size="small" variant="ghost" disabled={pending()} onClick={check}>
              {language.t("session.message.delivery.check")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" disabled={pending()} onClick={retry}>
              {language.t("session.message.delivery.retry")}
            </ButtonV2>
          </div>
        </div>
      )}
    </Show>
  )
}
