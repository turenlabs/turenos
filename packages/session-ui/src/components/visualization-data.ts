import { Visualization } from "@turenlabs/schema/visualization"
import { Option, Schema } from "effect"

export function visualizationSpec(metadata: unknown): Visualization.Spec | undefined {
  if (typeof metadata !== "object" || metadata === null || !("structured" in metadata)) return
  return Option.getOrUndefined(Schema.decodeUnknownOption(Visualization.Spec)(metadata.structured))
}
