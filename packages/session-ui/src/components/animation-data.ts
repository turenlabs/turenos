import { Animation } from "@turenlabs/schema/animation"
import { Option, Schema } from "effect"

export function animationSpec(metadata: unknown): Animation.Spec | undefined {
  if (typeof metadata !== "object" || metadata === null || !("structured" in metadata)) return
  const structured = plainFields(metadata.structured)
  if (!Array.isArray(structured?.tracks) || structured.tracks.length > Animation.MAX_TRACKS) return
  // Solid stores add private symbols. Keep all JSON fields so excess-field validation still applies.
  const tracks = structured.tracks.map((value: unknown) => {
    const track = plainFields(value)
    if (Array.isArray(track?.keyframes) && track.keyframes.length > 32) return
    return track && Array.isArray(track.keyframes) ? { ...track, keyframes: Array.from(track.keyframes) } : track
  })
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Animation.Spec, { onExcessProperty: "error" })({ ...structured, tracks }),
  )
}

function plainFields(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}
