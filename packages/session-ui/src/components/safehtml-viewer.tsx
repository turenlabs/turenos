import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { safeHtmlSpec } from "./safehtml-data"
import { safeHtmlDocument } from "./safehtml-sanitize"
import { VisualizationLicenses } from "./visualization-licenses"

export default function SafeHtmlViewer(props: { metadata: unknown }) {
  const spec = createMemo(() => safeHtmlSpec(props.metadata))
  const document = createMemo(() => {
    const value = spec()
    return value ? safeHtmlDocument(value.html) : undefined
  })
  const [state, setState] = createStore({ expanded: false })

  return (
    <Show when={spec()} fallback={<p role="status">HTML data is unavailable or invalid.</p>}>
      {(value) => (
        <section data-component="safehtml-viewer" aria-label={value().title}>
          <header>
            <h3>{value().title}</h3>
            <Show when={value().description}>
              <p>{value().description}</p>
            </Show>
          </header>
          <Show
            when={document()}
            fallback={<p role="status">This HTML exceeds the rendering limits or cannot be displayed safely.</p>}
          >
            {(html) => (
              <iframe
                title={value().title}
                srcdoc={html()}
                sandbox=""
                referrerpolicy="no-referrer"
                loading="lazy"
                data-expanded={state.expanded ? "" : undefined}
              />
            )}
          </Show>
          <button type="button" aria-pressed={state.expanded} onClick={() => setState("expanded", !state.expanded)}>
            {state.expanded ? "Compact view" : "Expand view"}
          </button>
          <details>
            <summary>HTML source</summary>
            <pre>{value().html}</pre>
          </details>
          <VisualizationLicenses />
        </section>
      )}
    </Show>
  )
}
