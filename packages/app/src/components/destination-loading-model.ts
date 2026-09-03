export type DestinationLoadingDetail = "subtle" | "phase" | "elapsed"

export type DestinationLoadingModelInput = {
  detail?: DestinationLoadingDetail
  label: string
  phase?: string
  elapsedMs?: number
}

export function getDestinationLoadingModel(input: DestinationLoadingModelInput) {
  const detail = input.detail ?? "subtle"
  const phase = detail === "subtle" ? undefined : input.phase?.trim() || undefined
  const elapsed =
    detail === "elapsed" && input.elapsedMs !== undefined ? formatLoadingDuration(input.elapsedMs) : undefined
  const visibleLabel = phase ?? input.label

  return {
    visibleLabel,
    elapsed,
    announcement: phase ? `${input.label}: ${phase}` : input.label,
  }
}

export function formatLoadingDuration(elapsedMs: number) {
  const seconds = Math.floor(Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1_000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}
