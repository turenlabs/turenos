import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@turenlabs/ui/theme/context"
import { WordmarkV2 } from "@turenlabs/ui/v2/wordmark-v2"
import { startForgeScene, type ForgeScene } from "./launch-screen"

/**
 * The TurenOS lockup — the Ember Forge mark rendered inline beside the
 * wordmark, already formed (no forge-in), with the ember field drifting.
 * Used where the static Logo would otherwise sit (e.g. the new session
 * landing). Falls back to the static artwork when WebGL is unavailable.
 */
export function ForgeLogo(props: { class?: string }) {
  const [failed, setFailed] = createSignal(false)
  let host!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let forge: ForgeScene | undefined
  const dark = () => {
    try {
      return useTheme().mode() === "dark"
    } catch {
      return document.documentElement.dataset.colorScheme === "dark"
    }
  }

  onMount(() => {
    // A lost context (GPU reset or eviction) leaves a blank canvas; show the static artwork instead.
    canvas.addEventListener("webglcontextlost", () => {
      const lost = forge
      forge = undefined
      lost?.dispose()
      setFailed(true)
    })
    try {
      forge = startForgeScene({
        host,
        canvas,
        dark: dark(),
        static: true,
        layout: { markX: -5.6, markY: -0.05, scale: 2.45, lookX: -1.0, lookY: 0.1 },
      })
    } catch {
      setFailed(true)
    }
  })
  onCleanup(() => {
    const current = forge
    forge = undefined
    current?.dispose()
  })

  return (
    <div
      ref={host}
      data-component="forge-logo"
      class={props.class}
      style="position:relative;aspect-ratio:960/340;container-type:size"
    >
      <Show when={!failed()} fallback={<WordmarkV2 class="h-auto w-full" />}>
        <canvas ref={canvas} style="position:absolute;inset:0;width:100%;height:100%" />
        <div
          class="text-v2-background-bg-inverse"
          style={
            "position:absolute;left:35%;top:50%;transform:translateY(-50%);" +
            "font-size:44cqh;font-weight:600;letter-spacing:-0.035em;" +
            "font-family:var(--font-family-sans),Inter,system-ui,sans-serif;" +
            "white-space:nowrap"
          }
        >
          TurenOS
        </div>
      </Show>
    </div>
  )
}
