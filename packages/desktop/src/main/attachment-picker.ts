import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"

export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024
// Picked files ride to the server as file:// references, so the renderer only
// needs whole bytes when a preview is plausible — larger files send a mime head.
export const PICKED_FILE_PREVIEW_BYTES = 32 * 1024 * 1024
export const PICKED_FILE_HEAD_BYTES = 8 * 1024

export function createPickedFileAuthorizations(
  read: (path: string, previewBytes: number, headBytes: number) => Promise<{ bytes: ArrayBuffer; size: number }> = readAttachment,
) {
  const selections = new Map<string, { sender: number; paths: Set<string> }>()

  return {
    add(sender: number, paths: string[]) {
      const token = randomUUID()
      selections.set(token, { sender, paths: new Set(paths) })
      return token
    },
    async read(sender: number, token: string, path: string) {
      const selection = selections.get(token)
      if (selection?.sender !== sender || !selection.paths.delete(path))
        throw new Error("File was not selected by the picker")
      if (selection.paths.size === 0) selections.delete(token)
      return read(path, PICKED_FILE_PREVIEW_BYTES, PICKED_FILE_HEAD_BYTES)
    },
    release(sender: number, token: string) {
      if (selections.get(token)?.sender === sender) selections.delete(token)
    },
  }
}

export function assertAttachmentBudget(files: { size: number }[]) {
  if (files.every((file) => file.size <= MAX_ATTACHMENT_BYTES)) return
  throw new Error(`Selected attachments exceed the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`)
}

export async function readAttachment(
  filePath: string,
  previewBytes = PICKED_FILE_PREVIEW_BYTES,
  headBytes = PICKED_FILE_HEAD_BYTES,
) {
  const file = await open(filePath, "r")
  try {
    const info = await file.stat()
    const length = Math.min(info.size, info.size <= previewBytes ? previewBytes : headBytes)
    const bytes = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const result = await file.read(bytes, offset, length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + offset) as ArrayBuffer, size: info.size }
  } finally {
    await file.close()
  }
}
