import type { FilePart } from "@turenlabs/sdk/v2"
import { getFilename } from "@turenlabs/core/util/path"
import { ServerConnection } from "@/context/server"
import type { ServerSDK } from "@/context/server-sdk"
import type { Platform } from "@/context/platform"
import { showToast } from "@/utils/toast"

export function createSessionAttachmentActions(input: {
  serverSDK: () => Pick<ServerSDK, "server">
  platform: Pick<Platform, "revealPath">
  revealFailedTitle: () => string
}) {
  const canOpenAttachment = (file: FilePart) => {
    if (file.url.startsWith("data:")) return true
    if (!file.url.startsWith("file:")) return false
    // A server file path is not necessarily a path on this desktop.
    const path = file.filename ?? ""
    const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
    return absolute && ServerConnection.local(input.serverSDK().server) && !!input.platform.revealPath
  }

  const openAttachment = (file: FilePart) => {
    if (!canOpenAttachment(file)) return
    const path = file.filename ?? ""
    if (file.url.startsWith("file:")) {
      const owner = input.serverSDK().server
      const failed = () => showToast({ variant: "error", title: input.revealFailedTitle(), description: file.filename })
      void Promise.resolve()
        .then(() => {
          if (input.serverSDK().server !== owner || !canOpenAttachment(file)) return
          return input.platform.revealPath!(path)
        })
        .then((revealed) => {
          if (revealed === false) failed()
        }, failed)
      return
    }
    const download = () => {
      const anchor = document.createElement("a")
      anchor.href = file.url
      anchor.download = getFilename(file.filename) || "attachment"
      anchor.click()
    }
    const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
    if (input.platform.revealPath && absolute && ServerConnection.local(input.serverSDK().server)) {
      const owner = input.serverSDK().server
      void Promise.resolve()
        .then(() => {
          if (input.serverSDK().server !== owner || !input.platform.revealPath) return false
          return input.platform.revealPath(path)
        })
        .then((revealed) => {
          if (!revealed) download()
        }, download)
      return
    }
    download()
  }

  return { canOpenAttachment, openAttachment }
}
