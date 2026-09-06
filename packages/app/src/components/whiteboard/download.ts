// File System Access can be exposed even when the desktop sandbox denies writes.
// Keep Excalidraw's export UI, but save via the browser's download mechanism.
export async function fileSave(blob: Blob | Promise<Blob>, options: { fileName?: string } = {}) {
  const url = URL.createObjectURL(await blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = options.fileName ?? "Whiteboard"
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    // Downloads may consume the URL after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return null
}
