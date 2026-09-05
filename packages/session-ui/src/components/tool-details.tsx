import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "@turenlabs/ui/context/i18n"

export function ToolDetails(props: { input?: Record<string, unknown>; output?: string }) {
  const i18n = useI18n()
  return (
    <div data-component="tool-details" class="flex min-w-0 flex-col gap-3 p-3 text-12-regular">
      <Show when={props.input && Object.keys(props.input).length > 0}>
        <ToolDetailsText
          title={i18n.t("ui.toolDetails.input")}
          filename="tool-input.json"
          value={JSON.stringify(props.input, null, 2)}
        />
      </Show>
      <Show when={props.output !== undefined}>
        <ToolDetailsText
          title={i18n.t("ui.toolDetails.output")}
          filename="tool-output.txt"
          value={props.output ?? ""}
        />
      </Show>
    </div>
  )
}

// Keep expanded multi-megabyte results out of a single wrapped DOM text node.
// Pagination is only a display boundary; download always contains the original.
export function toolDetailPage(value: string, index: number) {
  const pages = Math.max(1, Math.ceil(value.length / 16_000))
  const page = Math.max(0, Math.min(pages - 1, index))
  return { page, pages, text: value.slice(page * 16_000, (page + 1) * 16_000) }
}

function ToolDetailsText(props: { title: string; value: string; filename: string }) {
  const i18n = useI18n()
  const [store, setStore] = createStore({ page: 0 })
  const page = createMemo(() => toolDetailPage(props.value, store.page))
  return (
    <section>
      <div class="mb-1 flex items-center justify-between gap-3 text-text-weak">
        <span>{props.title}</span>
        <Show when={page().pages > 1}>
          <button
            type="button"
            class="underline"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([props.value], { type: "text/plain;charset=utf-8" }))
              const link = document.createElement("a")
              link.href = url
              link.download = props.filename
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
          >
            {i18n.t("ui.toolDetails.download")}
          </button>
        </Show>
      </div>
      <pre
        data-scrollable
        tabIndex={0}
        aria-label={props.title}
        class="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono"
      >
        {page().text}
      </pre>
      <Show when={page().pages > 1}>
        <div class="mt-2 flex items-center gap-3 text-text-weak">
          <button
            type="button"
            disabled={page().page === 0}
            class="disabled:opacity-40"
            onClick={() => setStore("page", page().page - 1)}
          >
            {i18n.t("ui.toolDetails.previous")}
          </button>
          <span>{i18n.t("ui.toolDetails.page", { page: page().page + 1, pages: page().pages })}</span>
          <button
            type="button"
            disabled={page().page === page().pages - 1}
            class="disabled:opacity-40"
            onClick={() => setStore("page", page().page + 1)}
          >
            {i18n.t("ui.toolDetails.next")}
          </button>
        </div>
      </Show>
    </section>
  )
}
