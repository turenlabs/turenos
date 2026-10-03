import type { Session } from "../server"

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

export function hasFiles(revert: Session["revert"]) {
  return !!(revert?.files?.length || revert?.diff)
}

export function boundary(revert: Session["revert"]) {
  return JSON.stringify(
    revert
      ? [
          revert.messageID,
          revert.partID,
          revert.snapshot,
          revert.diff,
          revert.files?.map((file) => [file.path, file.status, file.additions, file.deletions, file.patch]),
        ]
      : null,
  )
}
