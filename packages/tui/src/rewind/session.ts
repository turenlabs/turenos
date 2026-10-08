import type { Session } from "../server"

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
