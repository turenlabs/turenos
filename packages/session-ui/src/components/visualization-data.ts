import { Visualization } from "@turenlabs/schema/visualization"
import { Option, Schema } from "effect"

export function visualizationIsHtml(tool: string, metadata: unknown) {
  if (tool === "safehtml") return true
  if (typeof metadata !== "object" || metadata === null || !("structured" in metadata)) return false
  const structured = metadata.structured
  return typeof structured === "object" && structured !== null && "html" in structured
}

export function visualizationSpec(metadata: unknown): Visualization.Spec | undefined {
  if (typeof metadata !== "object" || metadata === null || !("structured" in metadata)) return
  return Option.getOrUndefined(Schema.decodeUnknownOption(Visualization.Spec)(metadata.structured))
}
