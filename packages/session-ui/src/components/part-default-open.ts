import type { Part } from "@turenlabs/sdk/v2"

export function partDefaultOpen(part: Part, shell = false, edit = false, patch?: boolean) {
  if (part.type !== "tool") return
  if (part.state.status === "error") return true
  if (part.tool === "bash") return shell
  if (part.tool === "apply_patch") return patch ?? edit
  if (part.tool === "edit" || part.tool === "write") return edit
}
