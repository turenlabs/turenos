import {
  array,
  choice,
  identifier,
  invalid,
  location,
  name,
  numeric,
  object,
  optional,
  string,
  unique,
} from "./primitives"

const nonFinite = ["Infinity", "-Infinity", "NaN"]

/** Only the automation and run lists are collections; mutations answer with one object that
 * the automation controls check themselves. */
export function automations(route: string[], init: RequestInit | undefined, value: unknown) {
  if ((init?.method ?? "GET") !== "GET" || !(route.length === 1 || (route.length === 3 && route[2] === "run"))) return
  unique(array(value, 1000), (value) => {
    const item = object(value)
    identifier(item.id)
    if (route[2] === "run") return automationRun(route, item)
    automation(item)
  })
}

function automationRun(route: string[], item: Record<string, unknown>) {
  if (identifier(item.loopID) !== identifier(route[1])) invalid("automation identity")
  choice(item.status, ["claimed", "running", "succeeded", "failed", "cancelled", "skipped", "stale"])
}

function automation(item: Record<string, unknown>) {
  name(item.name)
  string(item.prompt)
  location(item.location)
  choice(item.status, ["active", "paused", "expired"])
  const schedule = object(item.schedule)
  choice(schedule.type, ["interval", "cron"])
  if (numeric(schedule.seconds) < 1) invalid("automation interval")
  name(schedule.timezone)
  if (schedule.type === "cron") name(schedule.expression)
  optional(item.nextRunAt, (value) => (typeof value === "number" ? numeric(value) : choice(value, nonFinite)))
  optional(item.eventTrigger, eventTrigger)
}

function eventTrigger(value: unknown) {
  if (value === null) return
  const trigger = object(value)
  choice(trigger.type, ["file-change", "session-end"])
  if (trigger.type === "file-change") {
    for (const path of array(trigger.paths, 100)) string(path, 4096)
    optional(trigger.debounceMs, (v) => (typeof v === "number" ? numeric(v) : choice(v, nonFinite)))
  } else if (trigger.type === "session-end") {
    optional(trigger.outcomes, (v) => array(v, 2).forEach((o) => choice(o, ["success", "failure"])))
    optional(trigger.sessionID, (v) => v !== null && identifier(v, "ses_"))
    optional(trigger.agent, (v) => v !== null && name(v))
  }
}
