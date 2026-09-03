import { Switch } from "@turenlabs/ui/v2/switch-v2"
import { createMemo } from "solid-js"
import { modelEffortDefaultIndex, modelEffortDisplay } from "./model-selection-display"
import "./model-effort-control.css"

export function ModelEffortControl(props: {
  variants: string[]
  current: string | undefined
  automatic: boolean
  onAutomaticChange: (automatic: boolean) => void
  onVariantChange: (variant: string) => void
}) {
  const index = createMemo(() => {
    const current = props.current ? props.variants.indexOf(props.current) : -1
    if (current >= 0) return current
    return modelEffortDefaultIndex(props.variants)
  })
  const value = createMemo(() => props.variants[index()] ?? props.variants[0])
  const display = createMemo(() => modelEffortDisplay(value() ?? "default"))
  const label = (position: number) => modelEffortDisplay(props.variants[position] ?? "default").label
  const progress = createMemo(() => (props.variants.length <= 1 ? 0 : (index() / (props.variants.length - 1)) * 100))

  return (
    <div data-component="model-effort-control">
      <div class="flex flex-col gap-1 px-3 pb-2 pt-3">
        <div class="text-[13px] font-[530] leading-5 text-v2-text-text-strong">How much should TurenOS think?</div>
        <div class="text-[11px] font-[440] leading-4 text-v2-text-text-faint">
          Automatic uses the model's configured behavior. Switch it off to choose an exact level.
        </div>
      </div>
      <div class="h-px bg-v2-border-border-muted" />
      <div class="p-3">
        <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2.5">
          <div class="min-w-0">
            <div class="text-[12px] font-[530] leading-4 text-v2-text-text-base">Automatic</div>
            <div class="truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">Use the model default</div>
          </div>
          <Switch
            checked={props.automatic}
            onChange={props.onAutomaticChange}
            hideLabel
            aria-label="Automatic reasoning"
            data-action="prompt-model-variant-automatic"
          >
            Automatic reasoning
          </Switch>
        </div>
        <div class="mt-4" classList={{ "opacity-35": props.automatic }}>
          <div class="flex min-h-10 items-end justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-[18px] font-[530] leading-6 text-v2-text-text-accent">{display().label}</div>
              <div class="truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">
                {display().description}
              </div>
            </div>
            <code class="shrink-0 pb-0.5 text-[9px] text-v2-text-text-faint">{value()}</code>
          </div>
          <input
            data-action="prompt-model-variant-slider"
            type="range"
            min="0"
            max={Math.max(0, props.variants.length - 1)}
            step="1"
            value={index()}
            disabled={props.automatic}
            aria-label="Manual reasoning level"
            aria-valuetext={display().label}
            style={{ "--model-effort-progress": `${progress()}%` }}
            onInput={(event) => {
              const variant = props.variants[Number(event.currentTarget.value)]
              if (variant) props.onVariantChange(variant)
            }}
          />
          <div class="flex justify-between gap-2 text-[8px] font-[530] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint">
            <span>{label(0)}</span>
            <span>{label(Math.floor((props.variants.length - 1) / 2))}</span>
            <span>{label(props.variants.length - 1)}</span>
          </div>
        </div>
        <div class="mt-4 flex justify-between gap-3 border-t border-v2-border-border-muted pt-2.5 text-[9px] leading-3 text-v2-text-text-faint">
          <span>Current behavior</span>
          <span class="text-right font-[530] text-v2-text-text-muted">
            {props.automatic ? "Model default / no override" : `Explicit override / ${value()}`}
          </span>
        </div>
      </div>
    </div>
  )
}
