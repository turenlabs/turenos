import { createTimeline, engine } from "animejs"
import type { Animation } from "@turenlabs/schema/animation"
import { animationKeyframes } from "./animation-keyframes"
import { animationCommand } from "./animation-protocol"
import { disableNativeMotion } from "./animation-motion"

// Read owned head data before searching the sanitized scene.
const data = JSON.parse(document.head.querySelector("#turen-animation-data")!.textContent!) as Animation.Spec & {
  token: string
}
const root = document.body.firstElementChild!
engine.fps = 30
const timeline = createTimeline({
  autoplay: false,
  defaults: { ease: "linear" },
  loop: false,
  onComplete: () => {
    timeline.pause()
    stopClock()
    report()
  },
})
const targets = new Map<string, Element | null>()
const status = {
  error: "",
  stopped: false,
  ready: true,
  lastReport: -Infinity,
  clock: undefined as number | undefined,
  pending: undefined as number | undefined,
}

try {
  if (data.tracks.length > 128 || root.querySelectorAll("*").length > 5000)
    throw new Error("This scene exceeds the animation limits.")
  disableNativeMotion(root)
  root.querySelectorAll("[id]").forEach((element) => {
    targets.set(element.id, targets.has(element.id) ? null : element)
  })
  data.tracks.forEach((track) => {
    const target = targets.get(track.target)
    if (!target) throw new Error(`Animation target is missing or duplicated: ${track.target}`)
    if (track.keyframes.length < 2 || track.keyframes.length > 32) throw new Error("Invalid animation keyframes.")
    // SVG geometry must remain an attribute even when the agent omits its initial value.
    if (
      target instanceof SVGElement &&
      ["x", "y", "cx", "cy", "r", "width", "height", "fill", "stroke"].includes(track.property)
    ) {
      target.setAttribute(track.property, String(track.keyframes[0]))
    }
    const frames = animationKeyframes(track.keyframes, track.duration)
    if (track.property === "textContent") {
      const label = { value: Number(track.keyframes[0]) }
      timeline.add(
        label,
        {
          value: frames,
          onUpdate: () => {
            target.textContent = String(Number(label.value.toPrecision(6)))
          },
        },
        track.at ?? 0,
      )
      target.textContent = String(label.value)
      return
    }
    timeline.add(target, { [track.property]: frames }, track.at ?? 0)
  })
  timeline.seek(0)
} catch (error) {
  timeline.pause()
  status.error = error instanceof Error ? error.message : "This animation cannot be displayed."
}

function report() {
  if (status.stopped) return
  window.clearTimeout(status.pending)
  status.pending = undefined
  const wait = 100 - (performance.now() - status.lastReport)
  if (wait > 0) {
    status.pending = window.setTimeout(report, wait)
    return
  }
  parent.postMessage(
    status.error
      ? { token: data.token, type: "error", message: status.error }
      : {
          token: data.token,
          type: status.ready ? "ready" : timeline.paused ? "state" : "clock",
          paused: timeline.paused,
          time: Math.max(0, Math.min(60000, timeline.currentTime)),
          duration: Math.min(60000, timeline.duration),
        },
    "*",
  )
  status.ready = false
  status.lastReport = performance.now()
}
report()

function stopClock() {
  window.clearInterval(status.clock)
  status.clock = undefined
}

function dispose() {
  status.stopped = true
  timeline.cancel()
  stopClock()
  window.clearTimeout(status.pending)
  window.removeEventListener("message", receive)
  document.removeEventListener("visibilitychange", visibility)
  window.removeEventListener("pagehide", dispose)
}

function receive(event: MessageEvent) {
  if (event.source !== parent || status.stopped) return
  const command = animationCommand(event.data, data.token)
  if (!command) return
  if (command.action === "stop") {
    dispose()
    return
  }
  if (status.error) return
  if (command.action === "pause") timeline.pause()
  if (command.action === "play" && !document.hidden) {
    timeline.play()
    if (status.clock === undefined)
      status.clock = window.setInterval(() => {
        if (timeline.paused) stopClock()
        report()
      }, 100)
  }
  if (command.action === "restart") {
    timeline.pause()
    timeline.seek(0)
  }
  if (command.action === "seek") {
    timeline.pause()
    timeline.seek(Math.min(command.value!, timeline.duration))
  }
  if (command.action === "speed") timeline.speed = command.value!
  if (timeline.paused) stopClock()
  report()
}
window.addEventListener("message", receive)
function visibility() {
  if (!document.hidden) return
  timeline.pause()
  stopClock()
  report()
}
document.addEventListener("visibilitychange", visibility)
window.addEventListener("pagehide", dispose, { once: true })
