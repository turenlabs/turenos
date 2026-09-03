import { Show, type JSX } from "solid-js"

export function PageHeader(props: { title: string; description?: string; eyebrow?: string; actions?: JSX.Element }) {
  return (
    <header
      data-component="page-header"
      class="flex shrink-0 items-center justify-between gap-4 border-b border-v2-border-border-muted px-5 py-3"
    >
      <div class="min-w-0">
        <Show when={props.eyebrow}>
          <p class="mb-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">
            {props.eyebrow}
          </p>
        </Show>
        <h1 class="truncate text-[15px] leading-5 text-v2-text-text-base [font-weight:650]">{props.title}</h1>
        <Show when={props.description}>
          <p class="mt-0.5 truncate text-[12px] leading-5 text-v2-text-text-muted">{props.description}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="shrink-0">{props.actions}</div>
      </Show>
    </header>
  )
}
