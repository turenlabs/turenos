import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@turenlabs/session-ui/markdown"

/** The saved model checkpoint is inspectable without parsing hidden Markdown on every refresh. */
export function CompactionSummary(props: {
  text: string
  label: string
  onSizeChange?: () => void
  onFileLink?: (path: string) => void
}) {
  const [state, setState] = createStore({ open: false })
  return (
    <details
      data-component="compaction-summary"
      class="text-12 text-text-weak"
      onToggle={(event) => {
        setState("open", event.currentTarget.open)
        props.onSizeChange?.()
      }}
    >
      <summary class="cursor-pointer py-2">{props.label}</summary>
      <Show when={state.open}>
        <Markdown
          text={props.text}
          class="py-2 text-text-base"
          onImageSettled={props.onSizeChange}
          onFileLink={props.onFileLink}
        />
      </Show>
    </details>
  )
}
