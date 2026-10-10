import type { Team } from "@turenlabs/schema/team"

export {
  assignedHandles,
  mergeMessages,
  parseFactoryParameters,
  replyContext,
  roomCoordinator,
  roomDeleteBlocker,
  selectFactoryTeammate,
} from "@turenlabs/client/team"

export function roomActivity(roomID: string, tasks: readonly Team.Task[], teammates: readonly Team.Teammate[]) {
  const active = tasks.filter(
    (task) => task.roomID === roomID && ["queued", "claimed", "running"].includes(task.status),
  )
  if (!active.length) return
  const names = [...new Set(active.map((task) => task.teammateID))].map(
    (id) => teammates.find((mate) => mate.id === id)?.name ?? "A teammate",
  )
  const label = names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ")
  const action = active.some((task) => task.status === "running") ? "working" : "getting ready"
  return `${label} ${names.length === 1 ? "is" : "are"} ${action}...`
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

export function pendingMessage<Client>(
  pending: { id: string; roomID: string; text: string; client: Client; generation: number } | undefined,
  current: { roomID: string; text: string; client: Client; generation: number },
  createID: () => string,
) {
  return pending ?? { id: createID(), ...current }
}

export function pendingFactoryOperation<Client>(
  pending: { id: string; roomID: string; client: Client; generation: number } | undefined,
  current: { roomID: string; client: Client; generation: number },
  createID: () => string,
) {
  return pending ?? { id: createID(), ...current }
}
