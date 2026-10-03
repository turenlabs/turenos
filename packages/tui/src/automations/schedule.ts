import type { Loop } from "./types"

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

/**
 * "every 15m", "every 2h", "30m", or a five-field cron expression such as "0 9 * * 1-5", which runs
 * in this computer's time zone.
 */
export function parseSchedule(text: string) {
  const value = text.trim().toLowerCase()
  const every = /^(?:every\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)$/.exec(value)
  if (every) return { intervalSeconds: Number(every[1]) * UNIT[every[2]![0]!]! }
  if (/^(\S+\s+){4}\S+$/.test(value))
    return { cronExpression: value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  return undefined
}

export function scheduleInput(loop: Loop) {
  if (loop.schedule.type === "cron") return loop.schedule.expression
  const seconds = loop.schedule.seconds
  const unit = (["d", "h", "m"] as const).find((unit) => seconds % UNIT[unit]! === 0) ?? "s"
  return `every ${seconds / UNIT[unit]!}${unit}`
}
