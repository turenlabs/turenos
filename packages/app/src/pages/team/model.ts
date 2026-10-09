import { Team } from "@turenlabs/schema/team"

export function mergeMessages(existing: readonly Team.Message[], incoming: readonly Team.Message[]) {
  const messages = new Map(existing.map((message) => [message.id, message]))
  incoming.forEach((message) => messages.set(message.id, message))
  return [...messages.values()].sort((a, b) => a.seq - b.seq)
}

export function replyContext(message: Team.Message, messages: readonly Team.Message[]) {
  if (!message.replyTo) return
  const source = messages.find((item) => item.id === message.replyTo)
  if (!source) return
  const text = source.text.replace(/\s+/g, " ").trim()
  return { author: source.author, excerpt: text.length > 160 ? `${text.slice(0, 159)}…` : text }
}

export function assignedHandles(text: string, teammates: readonly Team.Teammate[]) {
  const handles = new Set(teammates.map((teammate) => teammate.handle.toLowerCase()))
  return Team.mentionedHandles(text).filter((handle) => handles.has(handle))
}

export function ownsTeamResponse<Client>(
  request: { client: Client; roomID?: string; generation?: number },
  current: { client: Client; roomID?: string; generation?: number },
) {
  return (
    request.client === current.client && request.roomID === current.roomID && request.generation === current.generation
  )
}

export function timeLabel(time: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time)
}

export function roomCoordinator(room: Team.Room, teammates: readonly Team.Teammate[]) {
  const configured = room.factory?.config.coordinatorTeammateID
  if (configured) return teammates.find((teammate) => teammate.id === configured)
  return teammates
    .filter((teammate) => teammate.status === "active")
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))[0]
}

export function roomDeleteBlocker(
  value: Team.State,
  schedules: readonly { factoryRoomID?: string; teammateID?: string }[],
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

export function pendingMessage<Client>(
  pending: { id: string; roomID: string; text: string; client: Client; generation: number } | undefined,
  current: { roomID: string; text: string; client: Client; generation: number },
  createID: () => string,
) {
  return pending ?? { id: createID(), ...current }
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

export function pendingFactoryOperation<Client>(
  pending: { id: string; roomID: string; client: Client; generation: number } | undefined,
  current: { roomID: string; client: Client; generation: number },
  createID: () => string,
) {
  return pending ?? { id: createID(), ...current }
}
