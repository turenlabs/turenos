import type { Room, TeamView } from "./types"

/** The first time a room is listed it counts as read up to its newest message, so it starts at zero new. */
export function baseline(view: TeamView) {
  view.rooms.forEach((room) => {
    if (!view.seen.has(room.id)) view.seen.set(room.id, room.head)
  })
}

/** Messages that arrived in a room since the reader last saw its tail in this process. */
export function newMessages(view: TeamView, room: Room) {
  // The open room counts as seen while the reader follows its tail.
  if (view.room?.id === room.id && (view.follow || view.following)) return 0
  return Math.max(0, room.head - (view.seen.get(room.id) ?? room.head))
}

/** The reader is following the newest message of the open room, so everything in it has been seen. */
export function markSeen(view: TeamView, room: Room) {
  view.seen.set(room.id, room.head)
}

/**
 * What the open room waits on the reader for: factory runs that need input, plus tasks whose session has a pending
 * permission or question. A task of a run that needs input counts through the run, not twice.
 */
export function waitingOnYou(view: TeamView, needsInput: readonly string[] = []) {
  const runs = view.factoryRuns.filter((run) => run.status === "needs_input")
  return (
    runs.length +
    view.tasks.filter(
      (task) =>
        needsInput.includes(task.sessionID) &&
        !runs.some((run) => task.factoryRunID === run.id || run.taskIDs.includes(task.id)),
    ).length
  )
}
