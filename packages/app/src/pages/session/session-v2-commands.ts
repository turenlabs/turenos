import type { CommandOption } from "@/context/command"
import type { DirectorySDK } from "@/context/sdk"

/**
 * Manual compaction. Unlike undo/redo this deliberately does not interrupt first: the server
 * refuses to compact a busy session and says so, which is safer than silently killing a turn the
 * user is watching. The client is configured with `throwOnError`, so a refusal reaches the caller.
 */
export async function compactSessionV2(client: DirectorySDK["client"], sessionID: string) {
  await client.v2.session.compact({ sessionID })
}

export function createSessionV2TranscriptCommands(input: {
  command: (option: Omit<CommandOption, "category">) => CommandOption
  showNew: boolean
  onNew: () => void
  onUndo: () => void
  onRedo: () => void
  onCompact: () => void
  canUndo: boolean
  canRedo: boolean
  canCompact: boolean
  labels: {
    new: string
    undo: string
    undoDescription: string
    redo: string
    redoDescription: string
    compact: string
    compactDescription: string
  }
}) {
  // `fork` stays absent: the V1 implementation copies the V1 message tables and can silently omit
  // post-adoption V2 messages. `compact` no longer has that problem -- it routes to
  // POST /api/session/:id/compact, which summarises the durable V2 transcript itself and reports
  // a typed failure rather than succeeding with a partial copy.
  return [
    ...(input.showNew
      ? [
          input.command({
            id: "session.new",
            title: input.labels.new,
            keybind: "mod+shift+s",
            slash: "new",
            onSelect: input.onNew,
          }),
        ]
      : []),
    input.command({
      id: "session.undo",
      title: input.labels.undo,
      description: input.labels.undoDescription,
      slash: "undo",
      disabled: !input.canUndo,
      onSelect: input.onUndo,
    }),
    input.command({
      id: "session.redo",
      title: input.labels.redo,
      description: input.labels.redoDescription,
      slash: "redo",
      disabled: !input.canRedo,
      onSelect: input.onRedo,
    }),
    input.command({
      id: "session.compact",
      title: input.labels.compact,
      description: input.labels.compactDescription,
      slash: "compact",
      disabled: !input.canCompact,
      onSelect: input.onCompact,
    }),
  ]
}
