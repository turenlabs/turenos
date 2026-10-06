export function animationCommand(value: unknown, token: string) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    value.token !== token ||
    !("action" in value)
  )
    return
  if (value.action === "play" || value.action === "pause" || value.action === "restart" || value.action === "stop")
    return { action: value.action }
  if (!("value" in value) || typeof value.value !== "number" || !Number.isFinite(value.value)) return
  if (value.action === "seek" && value.value >= 0 && value.value <= 60000)
    return { action: value.action, value: value.value }
  if (value.action === "speed" && [0.25, 0.5, 1, 1.5, 2].includes(value.value))
    return { action: value.action, value: value.value }
}

export function animationMessage(event: Pick<MessageEvent, "source" | "data">, source: Window | null, token: string) {
  if (!source || event.source !== source) return
  const value: unknown = event.data
  if (typeof value !== "object" || value === null || !("token" in value) || value.token !== token || !("type" in value))
    return
  if (value.type === "error" && "message" in value && typeof value.message === "string")
    return { type: "error" as const, message: value.message.slice(0, 1000) }
  if (value.type !== "ready" && value.type !== "state" && value.type !== "clock") return
  if (
    !("paused" in value) ||
    typeof value.paused !== "boolean" ||
    !("time" in value) ||
    typeof value.time !== "number" ||
    !Number.isFinite(value.time) ||
    value.time < 0 ||
    value.time > 60000
  )
    return
  if (
    !("duration" in value) ||
    typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) ||
    value.duration < 100 ||
    value.duration > 60000
  )
    return
  return { type: value.type, paused: value.paused, time: value.time, duration: value.duration } as const
}
