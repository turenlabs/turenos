const WINDOW_MS = 60_000
const WATCHDOG_MS = 100
const LAG_THRESHOLD_MS = 200

export function installStartupDiagnostics() {
  const startedAt = performance.now()
  const trace = (event: string, detail: Record<string, unknown> = {}) =>
    console.info(
      "[startup.renderer]",
      JSON.stringify({ event, elapsedMs: Math.round(performance.now() - startedAt), ...detail }),
    )
  const target = (event: Event) => {
    const element = event.target instanceof Element ? event.target.closest("a,button,[role=tab],[data-action]") : null
    if (!element) return {}
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? undefined,
      action: element.getAttribute("data-action") ?? undefined,
      component: element.getAttribute("data-component") ?? undefined,
    }
  }
  const input = (event: Event) => {
    const detail = target(event)
    trace(`input.${event.type}`, detail)
    if (event.type !== "click") return
    const clickedAt = performance.now()
    requestAnimationFrame(() =>
      trace("input.click-painted", { delayMs: Math.round(performance.now() - clickedAt), ...detail }),
    )
  }
  document.addEventListener("pointerdown", input, true)
  document.addEventListener("click", input, true)

  let expected = performance.now() + WATCHDOG_MS
  const watchdog = window.setInterval(() => {
    const now = performance.now()
    const lagMs = now - expected
    expected = now + WATCHDOG_MS
    if (lagMs >= LAG_THRESHOLD_MS) trace("event-loop-lag", { lagMs: Math.round(lagMs) })
  }, WATCHDOG_MS)

  const observer =
    typeof PerformanceObserver === "function"
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            trace("long-task", { durationMs: Math.round(entry.duration), startMs: Math.round(entry.startTime) })
          }
        })
      : undefined
  try {
    observer?.observe({ entryTypes: ["longtask"] })
  } catch {
    observer?.disconnect()
  }

  trace("armed")
  window.setTimeout(() => {
    window.clearInterval(watchdog)
    observer?.disconnect()
    document.removeEventListener("pointerdown", input, true)
    document.removeEventListener("click", input, true)
    trace("disarmed")
  }, WINDOW_MS)
}
