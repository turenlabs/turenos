import type {
  SessionTaskStatus as GeneratedSessionTaskStatus,
  SessionTaskSummary,
  SwarmRoomEntry,
} from "@turenlabs/sdk/v2/client"
import { Swarm } from "@turenlabs/schema/swarm"
import type { ThinkingState } from "@turenlabs/ui/thinking"

// The task list summary omits wave, but live task events carry it for grouping in the dock.
export type SessionTaskStatus = GeneratedSessionTaskStatus
export type SessionTaskInfo = Omit<SessionTaskSummary, "status"> & { status: SessionTaskStatus; wave?: string }

export type SessionSwarmProgress = {
  status: Swarm.Invocation["status"]
  objective: string
  requested: number | string | undefined
  explicitCount: boolean
  admitted: number
  queued: number
  running: number
  completed: number
  failed: number
  cancelled: number
  total: number
  lanes: string[]
  evidenceCount: number
  evidenceUpdatedAt?: number
}

export function sessionSwarmRequest(
  prompts: readonly { readonly text: string; readonly time: number }[],
  pending?: string,
) {
  const pendingInvocation = pending === undefined ? undefined : Swarm.parse(pending)
  if (pendingInvocation) return { invocation: pendingInvocation, time: undefined }
  const latest = prompts.at(-1)
  if (!latest) return
  const invocation = Swarm.parse(latest.text)
  return invocation ? { invocation, time: latest.time } : undefined
}

export function sessionSwarmProgress(
  invocation: Swarm.Invocation,
  tasks: readonly SessionTaskInfo[],
  entries: readonly SwarmRoomEntry[],
): SessionSwarmProgress {
  const evidence = entries.filter((entry) => EVIDENCE_KINDS.has(entry.kind))
  const evidenceTimes = evidence.flatMap((entry) =>
    Number.isFinite(entry.timeCreated) ? [entry.timeCreated] : [],
  )
  return {
    status: invocation.status,
    objective: invocation.objective,
    requested: invocation.status === "ready" ? invocation.count : invocation.requestedCount,
    explicitCount: invocation.status === "ready" && invocation.explicitCount,
    admitted: tasks.filter((task) => task.status === "starting").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled" || task.status === "interrupted").length,
    total: tasks.length,
    lanes: [
      ...new Set(
        tasks
          .filter(sessionTaskRunning)
          .map((task) => task.description.trim())
          .filter(Boolean),
      ),
    ],
    evidenceCount: evidence.length,
    evidenceUpdatedAt: evidenceTimes.length > 0 ? Math.max(...evidenceTimes) : undefined,
  }
}

// Entries that carry an observation worth counting as evidence; claims, releases,
// plans, and chatter are coordination, not evidence.
const EVIDENCE_KINDS = new Set(["finding", "lead", "correction", "status"])

// The thinking engine selects its orb profile from `state` (see thinking-engine/presets
// STATE_TO_MODE), so these six names *are* the six animations. In the dock they carry
// identity, not status — the row's status badge is what says starting/running/failed.
const THINKING_PROFILES = ["working", "searching", "solving", "listening", "composing", "shaping"] as const

/** FNV-1a; only needs to be stable and well-spread, not cryptographic. */
function taskHash(id: string) {
  let hash = 2_166_136_261
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/**
 * Give every subagent its own animation so four running children are tellable apart.
 *
 * Deterministic, never random: the profile is derived from the durable task id, so a child
 * keeps its animation across re-renders, row remounts and reloads — which is the entire
 * point, since a re-rolled animation could not be used to track *which* child is which.
 * Within each block of six consecutive tasks the hash is walked forward to the next free
 * profile, so concurrent siblings never collide. Assignment reads only tasks earlier in
 * creation order, so an existing row never changes when a sibling is added or finishes.
 */
export function sessionTaskThinkingProfiles(taskIDs: readonly string[]) {
  const profiles: Record<string, ThinkingState> = {}
  let taken = new Set<number>()
  taskIDs.forEach((id, index) => {
    if (index % THINKING_PROFILES.length === 0) taken = new Set()
    let slot = taskHash(id) % THINKING_PROFILES.length
    while (taken.has(slot)) slot = (slot + 1) % THINKING_PROFILES.length
    taken.add(slot)
    profiles[id] = THINKING_PROFILES[slot]!
  })
  return profiles
}

export function applySessionTaskSnapshot(current: SessionTaskInfo | undefined, next: SessionTaskInfo) {
  if (!current) return next
  if (next.revision < current.revision) return current
  return next
}

export function sessionTaskIDs(tasks: Record<string, SessionTaskInfo | undefined>, rootSessionID: string) {
  return Object.values(tasks)
    .filter((task): task is SessionTaskInfo => !!task && task.rootSessionID === rootSessionID)
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
    .map((task) => task.id)
}

export function sessionTaskRoot(
  tasks: Record<string, SessionTaskInfo | undefined>,
  roots: Record<string, string | undefined>,
  sessionID: string,
) {
  return (
    roots[sessionID] ??
    Object.values(tasks).find((task) => task?.childSessionID === sessionID)?.rootSessionID ??
    sessionID
  )
}

const finite = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

export function sessionTaskElapsedSeconds(task: SessionTaskInfo, now: number) {
  // Every timestamp here is optional on the wire, and `Math.max(0, NaN)` is NaN — so a missing
  // start silently rendered as "NaNh NaNm". Treat an unknown boundary as "no elapsed time yet"
  // rather than letting it propagate into the formatter.
  const start = finite(task.time.started) ?? finite(task.time.created)
  if (start === undefined) return 0
  const end =
    finite(task.time.completed) ?? (sessionTaskRunning(task) ? finite(now) : finite(task.time.updated)) ?? finite(now)
  if (end === undefined) return 0
  return Math.max(0, Math.floor((end - start) / 1_000))
}

export function formatSessionTaskDuration(seconds: number) {
  // Defensive: this is a display path, and a non-finite value must never reach the user as "NaN".
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s"
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m ${whole % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function sessionTaskStatusLabel(status: SessionTaskStatus) {
  if (status === "queued") return "session.subagents.status.queued" as const
  if (status === "starting") return "session.subagents.status.starting" as const
  if (status === "running") return "session.subagents.status.running" as const
  if (status === "completed") return "session.subagents.status.completed" as const
  if (status === "failed") return "session.subagents.status.failed" as const
  if (status === "cancelled") return "session.subagents.status.cancelled" as const
  return "session.subagents.status.interrupted" as const
}

/** Non-terminal: still reconciled and cancellable, including tasks queued for a slot. */
export function sessionTaskActive(task: SessionTaskInfo) {
  return task.status === "queued" || sessionTaskRunning(task)
}

/** Holding a concurrency slot; a queued task is neither running nor terminal. */
export function sessionTaskRunning(task: SessionTaskInfo) {
  return task.status === "starting" || task.status === "running"
}
