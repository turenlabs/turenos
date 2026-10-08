export {
  assignedHandles,
  mergeMessages,
  parseFactoryParameters,
  roomCoordinator,
  roomDeleteBlocker,
  selectFactoryTeammate,
} from "@turenlabs/client/team"

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
