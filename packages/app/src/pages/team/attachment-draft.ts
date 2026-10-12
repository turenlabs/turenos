import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import { dataUrl } from "@/components/prompt-input/attachments"
import { attachmentMime } from "@/components/prompt-input/files"
import { uuid } from "@/utils/uuid"
import { teamAttachmentMime, teamAttachmentProblem, teamAttachmentSize, type TeamAttachment } from "./attachments"

export type TeamDraftAttachment = TeamAttachment & { id: string; size: number }

export function createTeamAttachmentDraft(input: {
  /** Identifies the server and room that own the draft. Undefined while the room accepts no attachments. */
  scope: () => string | undefined
  onChange: () => void
  onError: (message: string | undefined) => void
  readClipboardImage?: () => Promise<File | null>
}) {
  const [store, setStore] = createStore<{ drafts: Record<string, TeamDraftAttachment[]>; reading: number }>({
    drafts: {},
    reading: 0,
  })
  // Reads run one at a time so two overlapping batches cannot both pass the limits.
  let queue = Promise.resolve()

  const list = () => store.drafts[input.scope() ?? ""] ?? []

  const read = async (scope: string, pending: File[] | Promise<File[]>) => {
    for (const file of await pending) {
      // The room or server changed while this batch was being read. It must not land anywhere else.
      if (input.scope() !== scope) return
      const problem = teamAttachmentProblem(store.drafts[scope] ?? [], file)
      if (problem) {
        input.onError(problem)
        continue
      }
      const mime = teamAttachmentMime(await attachmentMime(file))
      const uri = await dataUrl(file, mime)
      if (input.scope() !== scope) return
      // A File can declare more bytes than it carries. Never send a partial file as the whole one.
      if (teamAttachmentSize({ name: file.name, mime, uri }) !== file.size) {
        input.onError(`Could not read ${file.name}.`)
        continue
      }
      setStore("drafts", scope, (items = []) => [...items, { id: uuid(), name: file.name, mime, uri, size: file.size }])
      input.onChange()
    }
  }

  const add = (pending: File[] | Promise<File[]>) => {
    const scope = input.scope()
    if (!scope || (Array.isArray(pending) && pending.length === 0)) return Promise.resolve()
    setStore("reading", (count) => count + 1)
    input.onError(undefined)
    queue = queue
      .then(() => read(scope, pending))
      .catch(() => input.onError("Could not read the attachment."))
      .finally(() => setStore("reading", (count) => count - 1))
    return queue
  }

  const paste = (event: ClipboardEvent) => {
    const data = event.clipboardData
    if (!data || !input.scope()) return Promise.resolve()
    const files = Array.from(data.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })
    if (files.length > 0) {
      event.preventDefault()
      return add(files)
    }
    // Desktop: the browser clipboard has no files and no text, so try the native clipboard for an image.
    if (data.getData("text/plain") || !input.readClipboardImage) return Promise.resolve()
    return add(input.readClipboardImage().then((file) => (file ? [file] : [])))
  }

  const drop = (event: DragEvent) => {
    // Always cancel: an unhandled file drop navigates the window to that file.
    event.preventDefault()
    // Only the dropped bytes are read. Dropped links and host paths are never fetched or resolved.
    return add(Array.from(event.dataTransfer?.files ?? []))
  }

  const remove = (id: string) => {
    const scope = input.scope()
    if (!scope) return
    setStore("drafts", scope, (items = []) => items.filter((item) => item.id !== id))
    input.onChange()
  }

  return {
    list,
    attachments: () => list().map((item) => ({ name: item.name, mime: item.mime, uri: item.uri })),
    reading: () => store.reading > 0,
    add,
    paste,
    drop,
    remove,
    clear: (scope: string, ids: readonly string[]) =>
      setStore("drafts", scope, (items = []) => items.filter((item) => !ids.includes(item.id))),
    /** Frees every draft except the listed scopes. */
    prune: (keep: readonly (string | undefined)[]) =>
      batch(() =>
        Object.keys(store.drafts)
          .filter((scope) => !keep.includes(scope))
          .forEach((scope) => setStore("drafts", scope, undefined!)),
      ),
  }
}
