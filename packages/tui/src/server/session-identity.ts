import type { Session } from "./context"

/** Stable identity captured before a mutation; mutable title, model and usage do not retarget it. */
export function sameSession(left: Session, right: Session) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.parentID === right.parentID &&
    left.subpath === right.subpath &&
    left.time.created === right.time.created &&
    left.location.directory === right.location.directory &&
    left.location.workspaceID === right.location.workspaceID
  )
}
