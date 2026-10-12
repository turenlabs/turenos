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

export type TaskRequest = "question" | "permission"

// `waiting` maps a task Session ID to the prompt it is blocked on (see `taskRequests`).
export function roomActivity(
  roomID: string,
  tasks: readonly Team.Task[],
  teammates: readonly Team.Teammate[],
  waiting: ReadonlyMap<string, TaskRequest> = new Map(),
) {
  const active = tasks.filter(
    (task) => task.roomID === roomID && ["queued", "claimed", "running"].includes(task.status),
  )
  if (!active.length) return
  const blocked = active.filter((task) => waiting.has(task.sessionID))
  const busy = active.filter((task) => !waiting.has(task.sessionID))
  const action = busy.some((task) => task.status === "running") ? "working" : "getting ready"
  const parts = [
    blocked.length && phrase(blocked, teammates, ["needs", "need"], "your input"),
    busy.length && phrase(busy, teammates, ["is", "are"], `${action}...`),
  ].filter((part): part is string => !!part)
  return { text: parts.join(" · "), working: busy.length > 0 }
}

function phrase(
  tasks: readonly Team.Task[],
  teammates: readonly Team.Teammate[],
  verb: readonly [string, string],
  rest: string,
) {
  const names = [...new Set(tasks.map((task) => task.teammateID))].map(
    (id) => teammates.find((mate) => mate.id === id)?.name ?? "A teammate",
  )
  const label = names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ")
  return `${label} ${names.length === 1 ? verb[0] : verb[1]} ${rest}`
}

// A pending question or permission prompt in a task's Session, or in any subagent Session
// below it, blocks that task until the user answers it in the Session. Attribute each
// prompt to its task by walking parent links; questions win when both are pending.
export function taskRequests(
  sessionIDs: readonly string[],
  pending: {
    question: Readonly<Record<string, readonly unknown[] | undefined>>
    permission: Readonly<Record<string, readonly unknown[] | undefined>>
  },
  parentID: (sessionID: string) => string | undefined,
) {
  const tasks = new Set(sessionIDs)
  const owner = (sessionID: string) => {
    const seen = new Set<string>()
    for (let id: string | undefined = sessionID; id && !seen.has(id); id = parentID(id)) {
      if (tasks.has(id)) return id
      seen.add(id)
    }
  }
  return (["question", "permission"] as const).reduce((result, kind) => {
    for (const [sessionID, items] of Object.entries(pending[kind])) {
      const id = items?.length ? owner(sessionID) : undefined
      if (id && !result.has(id)) result.set(id, kind)
    }
    return result
  }, new Map<string, TaskRequest>())
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

// Generic so a retry keeps everything the first attempt captured, including its attachments.
export function pendingMessage<Current extends { roomID: string; text: string; client: unknown; generation: number }>(
  pending: (Current & { id: string }) | undefined,
  current: Current,
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
