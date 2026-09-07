import type { LoopEventTrigger, LoopInfo } from "./api"

export type TriggerKind = "interval" | "cron" | "file-change" | "session-end"

export type SessionOutcomeFilter = "both" | "success" | "failure"

/** Builder-local trigger draft. Every field stays a raw string until save, like `interval` today. */
export type TriggerDraft = {
  readonly kind: TriggerKind
  readonly interval: string
  readonly cronExpression: string
  readonly timezone: string
  readonly eventPaths: string
  readonly debounceMs: string
  readonly sessionOutcomes: SessionOutcomeFilter
  readonly sessionID: string
  readonly eventAgent: string
}

export type BuiltTriggerInput = {
  readonly intervalSeconds?: number
  readonly cronExpression?: string
  readonly timezone: string
  readonly eventTrigger?: LoopEventTrigger
}

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
  if (!expression.trim() || expression.length > 120)
    return "Cron expression must be five fields like '*/5 * * * *'"
  if (expression.trim().split(/\s+/).length !== 5)
    return "Cron expression must have five fields: minute hour day month weekday"
}

/** Same entry rule as core `validateTimezone`: non-blank and a known IANA name. */
export function validateTimezone(timezone: string): string | undefined {
  if (!timezone.trim()) return "A timezone is required"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return
  } catch {
    return `Unsupported timezone: ${timezone}`
  }
}

const GLOB_CHARSET = /^[A-Za-z0-9_.\-/*?{}[\]!+,@()|]+$/

/** Same rules as core `validateGlobPattern`: relative, dir-scoped, charset-bound. */
export function validateGlobPattern(pattern: string): string | undefined {
  if (!pattern.trim() || pattern.length > 256) return `Unsupported file-change pattern: ${pattern}`
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern) || pattern.includes("\\"))
    return `File-change patterns must be relative: ${pattern}`
  if (pattern.split("/").includes("..")) return `File-change patterns must not escape the directory: ${pattern}`
  if (!GLOB_CHARSET.test(pattern)) return `Unsupported file-change pattern: ${pattern}`
}

/** One relative glob per line, like the builder textarea holds them. */
export function parseEventPaths(value: string): Array<string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Same bounds as core: an integer between 0 and 60000 ms. Blank means omitted. */
export function validateDebounceMs(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return
  if (!/^\d+$/.test(trimmed)) return "File-change debounce must be between 0 and 60000 ms"
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 60_000)
    return "File-change debounce must be between 0 and 60000 ms"
}

/** Only call after `validateDebounceMs` passes: blank means omitted. */
export function parseDebounceMs(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return
  return Number(trimmed)
}

/**
 * Maps a draft to exactly one protocol trigger field plus the timezone, matching
 * core's create rule (one of interval, cron, or event) and edit rule (at most one).
 */
export function buildTriggerInput(draft: TriggerDraft): { input?: BuiltTriggerInput; error?: string } {
  const timezone = draft.timezone.trim()
  const timezoneError = validateTimezone(timezone)
  if (timezoneError) return { error: timezoneError }
  if (draft.kind === "cron") {
    const cronError = validateCronExpression(draft.cronExpression)
    if (cronError) return { error: cronError }
    return { input: { cronExpression: draft.cronExpression.trim(), timezone } }
  }
  if (draft.kind === "file-change") {
    const paths = parseEventPaths(draft.eventPaths)
    if (paths.length < 1 || paths.length > 20)
      return { error: "File-change triggers require between 1 and 20 path patterns" }
    const invalidPattern = paths.find((pattern) => validateGlobPattern(pattern))
    if (invalidPattern) return { error: validateGlobPattern(invalidPattern) as string }
    const debounceError = validateDebounceMs(draft.debounceMs)
    if (debounceError) return { error: debounceError }
    const debounceMs = parseDebounceMs(draft.debounceMs)
    return {
      input: {
        timezone,
        eventTrigger: {
          type: "file-change",
          paths,
          ...(debounceMs === undefined ? {} : { debounceMs }),
        },
      },
    }
  }
  if (draft.kind === "session-end") {
    const sessionID = draft.sessionID.trim()
    const eventAgent = draft.eventAgent.trim()
    return {
      input: {
        timezone,
        eventTrigger: {
          type: "session-end",
          ...(draft.sessionOutcomes === "both" ? {} : { outcomes: [draft.sessionOutcomes] }),
          ...(sessionID ? { sessionID } : {}),
          ...(eventAgent ? { agent: eventAgent } : {}),
        },
      },
    }
  }
  const intervalSeconds = parseInterval(draft.interval)
  if (!intervalSeconds || intervalSeconds < 60) return { error: "Enter an interval of at least 60 seconds." }
  return { input: { intervalSeconds, timezone } }
}

/** Restores a builder draft from a persisted automation: event trigger wins over the schedule placeholder. */
export function triggerFromAutomation(automation: Pick<LoopInfo, "schedule" | "eventTrigger">): TriggerDraft {
  const timezone = automation.schedule.timezone
  const event = automation.eventTrigger
  if (event?.type === "file-change")
    return {
      kind: "file-change",
      interval: "1h",
      cronExpression: "",
      timezone,
      eventPaths: event.paths.join("\n"),
      debounceMs: event.debounceMs?.toString() ?? "",
      sessionOutcomes: "both",
      sessionID: "",
      eventAgent: "",
    }
  if (event?.type === "session-end") {
    const outcomes = event.outcomes ?? []
    const sessionOutcomes: SessionOutcomeFilter =
      outcomes.length === 1 && outcomes[0] !== undefined ? outcomes[0] : "both"
    return {
      kind: "session-end",
      interval: "1h",
      cronExpression: "",
      timezone,
      eventPaths: "",
      debounceMs: "",
      sessionOutcomes,
      sessionID: event.sessionID ?? "",
      eventAgent: event.agent ?? "",
    }
  }
  if (automation.schedule.type === "cron")
    return {
      kind: "cron",
      interval: "1h",
      cronExpression: automation.schedule.expression,
      timezone,
      eventPaths: "",
      debounceMs: "",
      sessionOutcomes: "both",
      sessionID: "",
      eventAgent: "",
    }
  return {
    kind: "interval",
    interval: formatInterval(automation.schedule.seconds),
    cronExpression: "",
    timezone,
    eventPaths: "",
    debounceMs: "",
    sessionOutcomes: "both",
    sessionID: "",
    eventAgent: "",
  }
}
