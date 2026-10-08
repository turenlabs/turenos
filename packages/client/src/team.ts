import type { Team } from "@turenlabs/schema/team"
import { mentionedHandles, teammateHandle } from "@turenlabs/schema/team-mention"

export { mentionedHandles, teammateHandle }

export function mergeMessages<M extends { id: string; seq: number }>(existing: readonly M[], incoming: readonly M[]) {
  const messages = new Map(existing.map((message) => [message.id, message]))
  incoming.forEach((message) => messages.set(message.id, message))
  return [...messages.values()].sort((a, b) => a.seq - b.seq)
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
  if (
    value.duties.length ||
    schedules.some(
      (schedule) =>
        schedule.factoryRoomID === value.room.id ||
        value.teammates?.some((teammate) => teammate.id === schedule.teammateID),
    )
  )
    return "Remove linked duties and schedules before you delete this room."
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
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Parameters must be a JSON object")
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
  // The limits Team.FactoryConfig enforces on the server.
  if (config.outcome.length > 4000) return "Outcome is limited to 4000 characters"
  if (config.constraints.length > 8000) return "Constraints are limited to 8000 characters"
  if (config.acceptanceCriteria.length > 4000) return "Acceptance criteria are limited to 4000 characters"
  if (!config.coordinatorTeammateID || !config.teammateIDs.includes(config.coordinatorTeammateID))
    return "Select a coordinator from the selected teammates"
  if (config.teammateIDs.length < 1 || config.teammateIDs.length > 10) return "Select between 1 and 10 teammates"
  if (config.teammateIDs.some((id) => !teammates?.some((teammate) => teammate.id === id)))
    return "Factory teammates must belong to this room"
}
