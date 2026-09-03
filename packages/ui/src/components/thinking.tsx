// Solid wrapper around the thinking-orbs Canvas engine port pinned in
// thinking-engine. Copyright (c) 2026 Jakub Antalik; see its MIT license there.

import { createEffect, createSignal, onCleanup, onMount, splitProps, type ComponentProps } from "solid-js"
import { THINKING_LABELS, ariaHidden, thinkingStyle } from "./thinking-engine/contract"
import { resolvePreset, type ThinkingSize, type ThinkingState } from "./thinking-engine/presets"
import { MODE_DRAWS } from "./thinking-engine/registry"
import { thinkingFrameScheduler } from "./thinking-engine/runtime"

export type { ThinkingSize, ThinkingState } from "./thinking-engine/presets"

export type ThinkingTheme = "auto" | "dark" | "light"

export interface ThinkingProps extends Omit<ComponentProps<"canvas">, "children" | "height" | "ref" | "width"> {
  state?: ThinkingState
  size?: ThinkingSize
  speed?: number
  paused?: boolean
  theme?: ThinkingTheme
}

export function Thinking(props: ThinkingProps) {
  const [local, rest] = splitProps(props, [
    "state",
    "size",
    "speed",
    "paused",
    "theme",
    "class",
    "classList",
    "style",
    "aria-label",
    "aria-hidden",
    "role",
  ])
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>()
  const [dark, setDark] = createSignal(false)
  const [intersecting, setIntersecting] = createSignal(true)
  const [pageVisible, setPageVisible] = createSignal(true)
  const [reducedMotion, setReducedMotion] = createSignal(false)
  const state = () => local.state ?? "working"
  const size = () => local.size ?? 64
  const hidden = () => ariaHidden(local["aria-hidden"])

  createEffect(() => {
    setDark(resolveDark(local.theme ?? "auto", canvas()))
  })

  onMount(() => {
    setPageVisible(document.visibilityState !== "hidden")
    const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined
    const color = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined
    setReducedMotion(motion?.matches ?? false)

    const updateMotion = () => setReducedMotion(motion?.matches ?? false)
    const updateTheme = () => setDark(resolveDark(local.theme ?? "auto", canvas()))
    const updateVisibility = () => setPageVisible(document.visibilityState !== "hidden")
    motion?.addEventListener("change", updateMotion)
    color?.addEventListener("change", updateTheme)
    document.addEventListener("visibilitychange", updateVisibility)

    const themeObserver = typeof MutationObserver === "function" ? new MutationObserver(updateTheme) : undefined
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-color-scheme", "data-theme"],
    })

    const visibilityObserver =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => setIntersecting(entry?.isIntersecting ?? true))
        : undefined
    const element = canvas()
    if (element) visibilityObserver?.observe(element)

    onCleanup(() => {
      motion?.removeEventListener("change", updateMotion)
      color?.removeEventListener("change", updateTheme)
      document.removeEventListener("visibilitychange", updateVisibility)
      themeObserver?.disconnect()
      visibilityObserver?.disconnect()
    })
  })

  createEffect(() => {
    const element = canvas()
    if (!element) return
    const tunedSize = size()
    const preset = resolvePreset(state(), tunedSize)
    const speed = preset.speed * (local.speed ?? 1)
    const pixelRatio = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1)
    const context = element.getContext("2d")
    if (!context) return

    element.width = Math.round(tunedSize * pixelRatio)
    element.height = Math.round(tunedSize * pixelRatio)
    const draw = (seconds: number) => {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, tunedSize, tunedSize)
      MODE_DRAWS[preset.mode](context, tunedSize, seconds, dark(), preset.opts)
    }

    if (reducedMotion()) {
      draw(0.6)
      return
    }

    const frame = (milliseconds: number) => draw((milliseconds / 1000) * speed)
    frame(performance.now())
    if (local.paused || !intersecting() || !pageVisible()) return
    onCleanup(thinkingFrameScheduler.subscribe(frame))
  })

  return (
    <canvas
      {...rest}
      ref={(element) => setCanvas(element)}
      data-component="thinking"
      data-state={state()}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      style={thinkingStyle(local.style, size())}
      role={hidden() ? undefined : (local.role ?? "img")}
      aria-label={hidden() ? undefined : (local["aria-label"] ?? THINKING_LABELS[state()])}
      aria-hidden={local["aria-hidden"]}
    />
  )
}

function resolveDark(theme: ThinkingTheme, element: Element | null | undefined): boolean {
  if (theme === "dark") return true
  if (theme === "light") return false
  const inherited = inheritedDark(element)
  if (inherited !== undefined) return inherited
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
}

function inheritedDark(element: Element | null | undefined): boolean | undefined {
  if (!element) return
  const scheme = element.getAttribute("data-color-scheme")
  if (scheme === "dark") return true
  if (scheme === "light") return false
  const theme = element.getAttribute("data-theme")
  if (theme === "dark" || element.classList.contains("dark")) return true
  if (theme === "light" || element.classList.contains("light")) return false
  return inheritedDark(element.parentElement)
}
