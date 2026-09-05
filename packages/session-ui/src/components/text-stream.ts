import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"

/** Bound display lag even when a provider delivers a large burst or the tab was hidden. */
export function streamEnd(text: string, start: number, age: number) {
  const remaining = text.length - start
  if (remaining <= 128 || remaining >= 4_096 || age >= 120) return text.length
  const end = Math.min(text.length, start + Math.min(256, Math.ceil(remaining / 4)))
  const boundary = text.slice(end, end + 8).search(/[\s.,!?;:)\]]/)
  if (boundary >= 0) return end + boundary + 1
  // UTF-16 offsets must never leave half an emoji on screen.
  const char = text.charCodeAt(end)
  return char >= 0xdc00 && char <= 0xdfff ? end + 1 : end
}

export function createPacedValue(getValue: () => string, live: () => boolean) {
  const [state, setState] = createStore({ text: getValue() })
  const reducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)")
  let frame: number | undefined
  let pendingSince: number | undefined
  let shown = state.text

  const clear = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    pendingSince = undefined
  }
  const sync = (text: string) => {
    shown = text
    setState("text", text)
  }
  const run = () => {
    frame = undefined
    const text = getValue()
    const now = performance.now()
    const end =
      !live() || reducedMotion() || !text.startsWith(shown)
        ? text.length
        : streamEnd(text, shown.length, now - (pendingSince ?? now))
    sync(text.slice(0, end))
    if (end === text.length) {
      pendingSince = undefined
      return
    }
    frame = requestAnimationFrame(run)
  }

  createEffect(() => {
    const text = getValue()
    if (!live() || reducedMotion() || !text.startsWith(shown)) {
      clear()
      sync(text)
      return
    }
    if (text === shown || frame !== undefined) return
    // Coalesce ordinary token deltas into one paint; don't reparse Markdown on
    // every network event. Keep the oldest pending time while more deltas arrive.
    pendingSince ??= performance.now()
    frame = requestAnimationFrame(run)
  })
  onCleanup(clear)
  return () => state.text
}
