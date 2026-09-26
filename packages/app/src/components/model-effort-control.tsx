import { Switch } from "@turenlabs/ui/v2/switch-v2"
import { createMemo } from "solid-js"
import { modelEffortDefaultIndex, modelEffortDisplay } from "./model-selection-display"
import "./model-effort-control.css"

export function ModelEffortControl(props: {
  variants: string[]
  /** The level the user chose; undefined while following the default. */
  explicit: string | undefined
  /** What a turn runs at while following the default; undefined when no level is sent. */
  inherited: string | undefined
  onAutomaticChange: (automatic: boolean) => void
  onVariantChange: (variant: string) => void
}) {
  const automatic = () => props.explicit === undefined
  const effective = () => props.explicit ?? props.inherited
  const index = createMemo(() => {
    const current = effective()
    const position = current ? props.variants.indexOf(current) : -1
    if (position >= 0) return position
    return modelEffortDefaultIndex(props.variants)
  })
  const value = createMemo(() => props.variants[index()] ?? props.variants[0])
  const display = createMemo(() => modelEffortDisplay(effective() ?? "default"))
  const label = (position: number) => modelEffortDisplay(props.variants[position] ?? "default").label
  const progress = createMemo(() => (props.variants.length <= 1 ? 0 : (index() / (props.variants.length - 1)) * 100))
  const defaultSummary = () =>
    props.inherited ? `Uses ${modelEffortDisplay(props.inherited).label} (${props.inherited})` : "No level sent"

  return (
    <div data-component="model-effort-control">
      <div class="flex flex-col gap-1 px-3 pb-2 pt-3">
        <div class="text-[13px] font-[530] leading-5 text-v2-text-text-strong">How much should TurenOS think?</div>
        <div class="text-[11px] font-[440] leading-4 text-v2-text-text-faint">
          Default follows the agent or model setting. Switch it off to choose an exact level.
        </div>
      </div>
      <div class="h-px bg-v2-border-border-muted" />
      <div class="p-3">
        <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2.5">
          <div class="min-w-0">
            <div class="text-[12px] font-[530] leading-4 text-v2-text-text-base">Default</div>
            <div class="truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">{defaultSummary()}</div>
          </div>
          <Switch
            checked={automatic()}
            onChange={props.onAutomaticChange}
            hideLabel
            aria-label="Default reasoning"
            data-action="prompt-model-variant-automatic"
          >
            Default reasoning
          </Switch>
        </div>
        <div class="mt-4" classList={{ "opacity-35": automatic() }}>
          <div class="flex min-h-10 items-end justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-[18px] font-[530] leading-6 text-v2-text-text-accent">{display().label}</div>
              <div class="truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">
                {display().description}
              </div>
            </div>
            <code class="shrink-0 pb-0.5 text-[9px] text-v2-text-text-faint">{effective() ?? "—"}</code>
          </div>
          <input
            data-action="prompt-model-variant-slider"
            type="range"
            min="0"
            max={Math.max(0, props.variants.length - 1)}
            step="1"
            value={index()}
            disabled={automatic()}
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
          <span>Sent with each turn</span>
          <span class="text-right font-[530] text-v2-text-text-muted">
            {automatic()
              ? props.inherited
                ? `Default / ${props.inherited}`
                : "Nothing; provider decides"
              : `Override / ${value()}`}
          </span>
        </div>
      </div>
    </div>
  )
}
