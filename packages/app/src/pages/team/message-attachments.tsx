import { AttachmentCardV2 } from "@turenlabs/session-ui/v2/attachment-card-v2"
import { typeLabel } from "@turenlabs/session-ui/message-file"
import { For, Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { Team } from "@turenlabs/schema/team"
import { useServerSDK } from "@/context/server-sdk"
import { teamApi } from "./api"
import { observeTeamRichOutput } from "./rich-output"
import { teamAttachmentBlob, teamAttachmentInline, teamAttachmentSize, type TeamAttachment } from "./attachments"

export function TeamMessageAttachments(props: { message: Team.Message }) {
  const sdk = useServerSDK()
  const [state, setState] = createStore<{
    visible: boolean
    retry: number
    loaded?: {
      client: ReturnType<typeof sdk>["client"]
      roomID: string
      messageID: string
      files: readonly TeamAttachment[]
    }
    error: boolean
  }>({ visible: false, retry: 0, error: false })
  let element!: HTMLDivElement
  onMount(() => onCleanup(observeTeamRichOutput(element, () => setState("visible", true))))
  const files = () => {
    if (props.message.attachments) return props.message.attachments
    const loaded = state.loaded
    if (
      loaded?.client === sdk().client &&
      loaded.roomID === props.message.roomID &&
      loaded.messageID === props.message.id
    )
      return loaded.files
  }
  createEffect(() => {
    const client = sdk().client
    const roomID = props.message.roomID
    const messageID = props.message.id
    const visible = state.visible
    state.retry
    setState("error", false)
    if (!visible || files()) return
    let active = true
    onCleanup(() => {
      active = false
    })
    void teamApi(client)
      .messageAttachments({ roomID, messageID })
      .then((attachments) => {
        if (active) setState("loaded", { client, roomID, messageID, files: attachments })
      })
      .catch(() => {
        if (active) setState("error", true)
      })
  })
  return (
    <div ref={element}>
      <Show
        when={files()}
        fallback={
          <div role="status" class="mt-2 text-[12px] text-v2-text-text-muted">
            <For each={props.message.attachmentInfo}>{(file) => <span class="mr-2">{file.name}</span>}</For>
            <Show when={state.error} fallback={<span>Loading attachments…</span>}>
              Attachments could not be loaded.{" "}
              <button type="button" class="underline" onClick={() => setState("retry", (retry) => retry + 1)}>
                Retry
              </button>
            </Show>
          </div>
        }
      >
        <ul aria-label="Attachments" class="mt-2 flex flex-wrap items-end gap-2">
          <For each={files()}>
            {(attachment) => (
              <li class="min-w-0">
                <Show
                  when={teamAttachmentInline(attachment)}
                  fallback={
                    <Show
                      when={teamAttachmentSize(attachment) !== undefined}
                      fallback={
                        <AttachmentCardV2 title={attachment.name} hover={attachment.name}>
                          Unavailable
                        </AttachmentCardV2>
                      }
                    >
                      <button
                        type="button"
                        class="block text-left"
                        aria-label={`Download ${attachment.name}`}
                        onClick={() => download(attachment)}
                      >
                        <AttachmentCardV2 title={attachment.name} hover={attachment.name} clickable>
                          {typeLabel(attachment.name, attachment.mime)} · Download
                        </AttachmentCardV2>
                      </button>
                    </Show>
                  }
                >
                  {(src) => (
                    <img
                      src={src()}
                      alt={attachment.name}
                      title={attachment.name}
                      loading="lazy"
                      class="max-h-[240px] max-w-full rounded-[6px] border border-v2-border-border-base object-contain"
                    />
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function download(attachment: TeamAttachment) {
  const blob = teamAttachmentBlob(attachment)
  if (!blob) return
  const link = document.createElement("a")
  link.href = URL.createObjectURL(blob)
  link.download = attachment.name
  link.click()
  URL.revokeObjectURL(link.href)
}
