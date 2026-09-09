import type { LoopRun } from "./api"

export type LoopArtifact = LoopRun["outputs"][string]["artifacts"][number]

/** The path/URI understood by the app's file viewer for an artifact. */
export const artifactTarget = (artifact: LoopArtifact) =>
  artifact.type === "file" ? artifact.uri : artifact.path

/** Short, stable display text without hiding the target of an unnamed file. */
export const artifactLabel = (artifact: LoopArtifact) =>
  artifact.type === "file" ? (artifact.name ?? artifact.uri) : artifact.path

export function ArtifactChip(props: {
  artifact: LoopArtifact
  onOpen?: (target: string) => void
}) {
  const target = () => artifactTarget(props.artifact)
  const label = () => artifactLabel(props.artifact)
  const text = () =>
    props.artifact.type === "file"
      ? `${label()} · ${props.artifact.mime}`
      : `${props.artifact.type} · ${label()}`

  if (!props.onOpen) {
    return (
      <span data-component="automation-artifact-chip" class="truncate font-mono text-[10px] text-v2-text-text-muted">
        {text()}
      </span>
    )
  }

  return (
    <button
      type="button"
      data-component="automation-artifact-chip"
      title={`Open ${target()}`}
      class="min-w-0 truncate text-left font-mono text-[10px] text-v2-text-text-info hover:text-v2-text-text-strong focus:outline-none focus:ring-1 focus:ring-v2-border-border-focus"
      onClick={() => props.onOpen?.(target())}
    >
      {text()}
    </button>
  )
}
