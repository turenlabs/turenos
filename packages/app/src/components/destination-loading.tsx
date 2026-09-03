import { Spinner } from "@turenlabs/ui/spinner"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type ComponentProps } from "solid-js"
import { getDestinationLoadingModel, type DestinationLoadingDetail } from "./destination-loading-model"

export type { DestinationLoadingDetail } from "./destination-loading-model"

export type DestinationLoadingAction = {
  label: string
  onSelect: () => void
  disabled?: boolean
}

export interface DestinationLoadingProps extends Pick<ComponentProps<"div">, "class" | "classList" | "id"> {
  detail?: DestinationLoadingDetail
  label?: string
  phase?: string
  startedAt?: number
  elapsedMs?: number
  appearance?: "inline" | "chrome"
  retry?: DestinationLoadingAction
  background?: DestinationLoadingAction
}

export function DestinationLoading(props: DestinationLoadingProps) {
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (props.detail !== "elapsed") return
    if (props.elapsedMs !== undefined || props.startedAt === undefined) return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const elapsedMs = () => {
    if (props.elapsedMs !== undefined) return props.elapsedMs
    if (props.startedAt === undefined) return
    return now() - props.startedAt
  }
  const model = createMemo(() =>
    getDestinationLoadingModel({
      detail: props.detail,
      label: props.label ?? "Loading destination",
      phase: props.phase,
      elapsedMs: elapsedMs(),
    }),
  )
  const showLabel = () => props.appearance !== "chrome" || (props.detail ?? "subtle") !== "subtle"
  const actions = () =>
    [props.retry, props.background].filter((action): action is DestinationLoadingAction => action !== undefined)

  return (
    <div
      id={props.id}
      data-component="destination-loading"
      data-appearance={props.appearance ?? "inline"}
      data-detail={props.detail ?? "subtle"}
      style={{ "pointer-events": "none" }}
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
        "pointer-events-none inline-flex min-w-0 max-w-full items-center gap-1.5 text-[12px] leading-5": true,
        "text-v2-text-text-muted": props.appearance !== "chrome",
        "text-v2-text-text-faint": props.appearance === "chrome",
      }}
    >
      <span role="status" aria-live="polite" aria-atomic="true" class="sr-only">
        {model().announcement}
      </span>
      <span aria-hidden="true" class="inline-flex min-w-0 items-center gap-1.5">
        <Spinner class="size-3 shrink-0" />
        <Show when={showLabel()}>
          <span class="min-w-0 truncate">{model().visibleLabel}</span>
        </Show>
        <Show when={model().elapsed}>
          {(elapsed) => <span class="shrink-0 tabular-nums text-v2-text-text-faint">{elapsed()}</span>}
        </Show>
      </span>
      <Show when={model().elapsed}>{(elapsed) => <span class="sr-only">{elapsed()} elapsed</span>}</Show>
      <Show when={actions().length > 0}>
        <span class="pointer-events-auto inline-flex shrink-0 items-center gap-0.5">
          <For each={actions()}>
            {(action) => (
              <ButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                class="!h-5 !px-1.5 !text-[11px] !leading-4"
                disabled={action.disabled}
                onPointerDown={(event: PointerEvent) => event.stopPropagation()}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  action.onSelect()
                }}
              >
                {action.label}
              </ButtonV2>
            )}
          </For>
        </span>
      </Show>
    </div>
  )
}
