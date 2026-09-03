export function taskThinkingState(value: unknown) {
  if (typeof value !== "string") return "working" as const
  const type = value.toLowerCase()
  if (type === "explore" || type === "research" || type === "review") return "searching" as const
  if (type === "build" || type === "docs" || type === "writer") return "shaping" as const
  return "working" as const
}
