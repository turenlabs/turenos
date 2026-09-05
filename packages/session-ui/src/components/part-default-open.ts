import type { Part } from "@turenlabs/sdk/v2"

export function partDefaultOpen(part: Part, shell = false, edit = false) {
  if (part.type !== "tool") return
  if (part.state.status === "error") return true
  if (part.tool === "bash") return shell
  if (part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch") return edit
}
