// Browser-safe form checks shared by desktop and TUI. Core owns cron field parsing and execution.

/** The shortest interval Core schedules (its `MIN_INTERVAL_SECONDS`). */
export const minimumIntervalSeconds = 60

export const formatInterval = (seconds: number) => {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export const parseInterval = (interval: string) => {
  const match = interval.match(/^([1-9]\d*)([smhd])$/)
  if (!match) return
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] as "s" | "m" | "h" | "d"]
  if (!Number.isSafeInteger(seconds)) return
  return seconds
}

/**
 * Client-side cron check with the same entry rules as core
 * `validateCronExpression`: non-blank, 120-char max, exactly five fields.
 * Per-field ranges stay server-validated.
 */
export function validateCronExpression(expression: string): string | undefined {
  if (!expression.trim() || expression.length > 120) return "Cron expression must be five fields like '*/5 * * * *'"
  if (expression.trim().split(/\s+/).length !== 5)
    return "Cron expression must have five fields: minute hour day month weekday"
}
