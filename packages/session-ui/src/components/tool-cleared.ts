/**
 * Whether a completed tool result's content has been cleared from the model's context, and when.
 *
 * Compaction's pruner replaces old tool output with a short sentinel in the provider request and
 * records that on the part itself (`state.time.compacted` on the wire; `time.pruned` on the v2
 * message, lowered by the presentation layer). The transcript keeps every byte, so without reading
 * the mark the user reads a result the model can no longer see -- a divergence of hundreds of
 * thousands of characters with nothing on screen to signal it. V1 wrote the same mark and only
 * ever consumed it on the request side.
 *
 * Takes `unknown` rather than `ToolPart` on purpose: the timeline mixes the v1 and v2 part shapes,
 * `time.compacted` exists on exactly one arm of the state union, and this is a boundary read.
 */
export function toolResultCleared(part: unknown): number | undefined {
  const state = read(part, "state")
  if (read(state, "status") !== "completed") return undefined
  const value = read(read(state, "time"), "compacted")
  // A zero or negative timestamp is the absence of a mark, not a prune at the epoch.
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function read(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}
