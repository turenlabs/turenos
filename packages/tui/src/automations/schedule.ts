import type { Loop } from "./types"
import { formatInterval, parseInterval, validateCronExpression } from "@turenlabs/client/automation-schedule"

const EVERY = /^(?:every\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)$/
const MINIMUM = 60

/**
 * "every 15m", "every 2h", "30m", or a five-field cron expression such as "0 9 * * 1-5", which runs
 * in this computer's time zone. An edit that leaves a cron expression as it was keeps the time zone
 * it was created in, which can differ from this computer's.
 */
export function parseSchedule(text: string, current?: Loop["schedule"]) {
  const value = text.trim().toLowerCase()
  const every = EVERY.exec(value)
  if (every) {
    const intervalSeconds = parseInterval(`${Number(every[1])}${every[2]![0]}`)
    return intervalSeconds !== undefined && intervalSeconds >= MINIMUM ? { intervalSeconds } : undefined
  }
  // Match the desktop's entry checks; Core validates field ranges when the form is submitted.
  if (validateCronExpression(value)) return undefined
  const unchanged = current?.type === "cron" && current.expression.toLowerCase() === value
  return {
    cronExpression: value,
    timezone: unchanged ? current.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

/** Why `text` is not a schedule, in words the form can show as it is. */
export function scheduleProblem(text: string) {
  const value = text.trim().toLowerCase()
  const every = EVERY.exec(value)
  if (every) {
    const seconds = parseInterval(`${Number(every[1])}${every[2]![0]}`)
    if (Number(every[1]) === 0 || (seconds !== undefined && seconds < MINIMUM))
      return "The shortest interval is every 1m."
    return "That interval is too long. Use a shorter interval or a cron expression."
  }
  if (value.split(/\s+/).length === 5) return validateCronExpression(value) ?? "The server validates cron field ranges."
  return "Use a schedule like every 30m, every 1d, or a five-field cron expression."
}

export function scheduleInput(loop: Loop) {
  if (loop.schedule.type === "cron") return loop.schedule.expression
  return `every ${formatInterval(loop.schedule.seconds)}`
}
