import type { Team } from "@turenlabs/schema/team"
import { mentionedHandles, teammateHandle } from "@turenlabs/schema/team-mention"

export { mentionedHandles, teammateHandle }

export function mergeMessages<M extends { id: string; seq: number }>(existing: readonly M[], incoming: readonly M[]) {
  const messages = new Map(existing.map((message) => [message.id, message]))
  incoming.forEach((message) => messages.set(message.id, message))
  return [...messages.values()].sort((a, b) => a.seq - b.seq)
}

export function replyContext<M extends { id: string; author: string; text: string; replyTo?: string | null }>(
  message: M,
  messages: readonly M[],
) {
  if (!message.replyTo) return
  const source = messages.find((item) => item.id === message.replyTo)
  if (!source) return
  const text = source.text.replace(/\s+/g, " ").trim()
  return { author: source.author, excerpt: text.length > 160 ? `${text.slice(0, 159)}…` : text }
}

export function assignedHandles(text: string, teammates: readonly { handle: string }[]) {
  const handles = new Set(teammates.map((teammate) => teammate.handle.toLowerCase()))
  return mentionedHandles(text).filter((handle) => handles.has(handle))
}

export function roomCoordinator<T extends { id: string; status: string; time: { created: number } }>(
  room: { factory?: { config: { coordinatorTeammateID: string } } },
  teammates: readonly T[],
) {
  const configured = room.factory?.config.coordinatorTeammateID
  if (configured) return teammates.find((teammate) => teammate.id === configured)
  return teammates
    .filter((teammate) => teammate.status === "active")
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))[0]
}

/** The blocker shown when linked duties or schedules keep a room from being deleted. */
export const linkedBlocker = "Remove linked duties and schedules before you delete this room."

/** The schedules that point at the room or at one of its teammates. */
export function roomSchedules<S extends { factoryRoomID?: string | null; teammateID?: string | null }>(
  value: { room: { id: string }; teammates?: readonly { id: string }[] },
  schedules: readonly S[],
) {
  return schedules.filter(
    (schedule) =>
      schedule.factoryRoomID === value.room.id || value.teammates?.some((teammate) => teammate.id === schedule.teammateID),
  )
}

/** Structural, so a client holding only part of the state (or loops whose optional fields are null) can ask too. */
export function roomDeleteBlocker(
  value: {
    room: { id: string; archived?: boolean }
    tasks: readonly { status: string }[]
    factoryRuns?: readonly { status: string }[]
    duties: readonly unknown[]
    teammates?: readonly { id: string }[]
  },
  schedules: readonly { factoryRoomID?: string | null; teammateID?: string | null }[],
) {
  if (value.room.id === "trm_team") return "The default Team room cannot be deleted."
  if (!value.room.archived) return "Archive this room before you delete it."
  if (
    value.tasks.some((task) => ["queued", "claimed", "running"].includes(task.status)) ||
    value.factoryRuns?.some((run) => run.status === "running")
  )
    return "Wait for active work to finish before you delete this room."
  if (value.duties.length || roomSchedules(value, schedules).length) return linkedBlocker
}

/** What the create form sends: the name trimmed, the handle without a leading `@`, and a role that falls back to a default. */
export function teammateDraft(input: { name: string; handle: string; role: string; mission: string }) {
  return {
    name: input.name.trim(),
    handle: input.handle.trim().replace(/^@/, ""),
    role: input.role.trim() || "Security teammate",
    mission: input.mission,
  }
}

export function parseFactoryParameters(value: string): Team.FactoryConfig["parameters"] {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error('Parameters must be a JSON object, e.g. {"scope":"docs"}')
  return parsed as Team.FactoryConfig["parameters"]
}

export function selectFactoryTeammate(ids: readonly string[], teammateID: string, selected: boolean) {
  const next = selected ? [...new Set([...ids, teammateID])] : ids.filter((id) => id !== teammateID)
  if (next.length > 10) throw new Error("Select at most 10 teammates")
  return next
}

export function mentionToken(value: string, start: number, end = start) {
  if (start !== end || start < 0 || start > value.length) return
  const match = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z][a-zA-Z0-9_-]{0,31}|)$/.exec(value.slice(0, start))
  if (!match) return
  return { start: start - match[1]!.length - 1, end: start, query: match[1]! }
}

export function mentionMatches<T extends { handle: string; name: string; role: string }>(
  teammates: readonly T[],
  query: string,
) {
  const search = query.toLowerCase()
  return teammates.filter((teammate) =>
    [teammate.handle, teammate.name, teammate.role].some((value) => value.toLowerCase().includes(search)),
  )
}

export function insertMention(value: string, token: NonNullable<ReturnType<typeof mentionToken>>, handle: string) {
  const prefix = `${value.slice(0, token.start)}@${handle} `
  return { value: prefix + value.slice(token.end), caret: prefix.length }
}

/**
 * The limits Team.FactoryConfig sets in @turenlabs/schema (src/team.ts) and Core's configureFactory enforces. They are
 * restated because that module imports effect, which this one must stay free of.
 */
export const FACTORY_OUTCOME_MAX = 4000
export const FACTORY_CONSTRAINTS_MAX = 8000
export const FACTORY_ACCEPTANCE_MAX = 4000
export const FACTORY_DIRECTORY_MAX = 4096
export const FACTORY_ID_MAX = 256
export const FACTORY_TEAMMATES_MAX = 10

/** Why a factory configuration cannot be saved, or nothing when it can. */
export function factoryConfigProblem(
  config: {
    outcome: string
    constraints: string
    acceptanceCriteria: string
    directory: string
    coordinatorTeammateID: string
    teammateIDs: readonly string[]
  },
  teammates: readonly { id: string }[] | undefined,
) {
  if (!config.outcome.trim() || !config.acceptanceCriteria.trim() || !config.directory.trim())
    return "Outcome, acceptance criteria, and directory are required"
  if (config.outcome.length > FACTORY_OUTCOME_MAX) return `Outcome is limited to ${FACTORY_OUTCOME_MAX} characters`
  if (config.constraints.length > FACTORY_CONSTRAINTS_MAX)
    return `Constraints are limited to ${FACTORY_CONSTRAINTS_MAX} characters`
  if (config.acceptanceCriteria.length > FACTORY_ACCEPTANCE_MAX)
    return `Acceptance criteria are limited to ${FACTORY_ACCEPTANCE_MAX} characters`
  if (config.directory.length > FACTORY_DIRECTORY_MAX)
    return `Directory is limited to ${FACTORY_DIRECTORY_MAX} characters`
  if (!config.coordinatorTeammateID || !config.teammateIDs.includes(config.coordinatorTeammateID))
    return "Select a coordinator from the selected teammates"
  if (config.teammateIDs.length < 1 || config.teammateIDs.length > FACTORY_TEAMMATES_MAX)
    return `Select between 1 and ${FACTORY_TEAMMATES_MAX} teammates`
  if ([config.coordinatorTeammateID, ...config.teammateIDs].some((id) => id.length > FACTORY_ID_MAX))
    return `Teammate IDs are limited to ${FACTORY_ID_MAX} characters`
  if (config.teammateIDs.some((id) => !teammates?.some((teammate) => teammate.id === id)))
    return "Factory teammates must belong to this room"
}

/**
 * What a coordinator's reply holds when it is the factory's machine output: the plan it made or its verdict on the
 * work. Anything else, including JSON of another shape, is an ordinary message.
 */
export function factoryOutput(text: string) {
  const value = parseJson(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const output = value as { assignments?: unknown; status?: unknown; summary?: unknown }
  // The same shapes and limits as Team.FactoryPlan and Team.FactoryCheck, checked without Schema so this module
  // stays free of effect for the terminal client.
  if (Array.isArray(output.assignments) && output.assignments.length && output.assignments.every(assignment))
    return { kind: "plan" as const, assignments: output.assignments as { teammateID: string; prompt: string }[] }
  if (
    (output.status === "accepted" || output.status === "needs_input" || output.status === "rejected") &&
    text_(output.summary, 8_000)
  )
    return {
      kind: "check" as const,
      status: output.status as Team.FactoryCheck["status"],
      summary: output.summary as string,
    }
}

function assignment(item: unknown) {
  const value = item as { teammateID?: unknown; prompt?: unknown } | null
  return !!value && typeof value === "object" && text_(value.teammateID, 256) && text_(value.prompt, 8_000)
}

function text_(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
}

/** JSON.parse that answers undefined for text that is not JSON, rather than throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
