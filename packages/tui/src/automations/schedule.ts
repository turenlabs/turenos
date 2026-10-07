import type { Loop } from "./types"

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
const EVERY = /^(?:every\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)$/
const MINIMUM = 60
const MAXIMUM = 366 * 86400
const NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: NAMES },
  { min: 0, max: 7, names: DAYS },
]

/**
 * "every 15m", "every 2h", "30m", or a five-field cron expression such as "0 9 * * 1-5", which runs
 * in this computer's time zone. An edit that leaves a cron expression as it was keeps the time zone
 * it was created in, which can differ from this computer's.
 */
export function parseSchedule(text: string, current?: Loop["schedule"]) {
  const value = text.trim().toLowerCase()
  const every = EVERY.exec(value)
  if (every) {
    const intervalSeconds = Number(every[1]) * UNIT[every[2]![0]!]!
    return intervalSeconds >= MINIMUM && intervalSeconds <= MAXIMUM ? { intervalSeconds } : undefined
  }
  if (!validCron(value)) return undefined
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
  if (every && Number(every[1]) * UNIT[every[2]![0]!]! < MINIMUM) return "The shortest interval is every 1m."
  if (every) return "The longest interval is every 366d."
  if (/^(\S+\s+){4}\S+$/.test(value))
    return "That cron expression is not valid. Use five fields: minute hour day month weekday."
  return "Use a schedule like every 30m, every 1d, or a five-field cron expression."
}

function validCron(value: string) {
  const fields = value.split(/\s+/)
  return (
    fields.length === 5 &&
    fields.every((field, index) => field.split(",").every((part) => validPart(part, FIELDS[index]!)))
  )
}

function validPart(part: string, range: { min: number; max: number; names?: string[] }) {
  const [span, step, ...rest] = part.split("/")
  if (rest.length || (step !== undefined && !/^[1-9]\d*$/.test(step))) return false
  if (span === "*") return true
  const ends = (span ?? "").split("-")
  if (ends.length > 2) return false
  const numbers = ends.map((end) => {
    const name = range.names?.indexOf(end)
    if (name !== undefined && name >= 0) return name + (range.min === 1 ? 1 : 0)
    return /^\d+$/.test(end) ? Number(end) : NaN
  })
  return (
    numbers.every((number) => number >= range.min && number <= range.max) &&
    (numbers[1] === undefined || numbers[0]! <= numbers[1])
  )
}

export function scheduleInput(loop: Loop) {
  if (loop.schedule.type === "cron") return loop.schedule.expression
  const seconds = loop.schedule.seconds
  const unit = (["d", "h", "m"] as const).find((unit) => seconds % UNIT[unit]! === 0) ?? "s"
  return `every ${seconds / UNIT[unit]!}${unit}`
}
