export type MarkdownImageResolver = (path: string) => Promise<string | undefined>

const scheme = /^[a-z][a-z\d+.-]*:/i
const windowsPath = /^[a-z]:[\\/]/i

export function localMarkdownPath(source: string) {
  const value = source.trim()
  if (!value || value.startsWith("#") || value.startsWith("//")) return
  if (value.toLowerCase().startsWith("file://")) return fileUrlPath(value)
  if (scheme.test(value) && !windowsPath.test(value)) return

  const path = value.split(/[?#]/, 1)[0]
  if (!path) return
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function fileUrlPath(source: string) {
  try {
    const url = new URL(source)
    if (url.hostname) return
    const path = decodeURIComponent(url.pathname)
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  } catch {
    return
  }
}

export function resolveMarkdownImages(root: ParentNode, resolve: MarkdownImageResolver, onSettled?: () => void) {
  let active = true
  const cleanups: Array<() => void> = []
  let resolving = false
  Array.from(root.querySelectorAll("img")).forEach((image) => {
    const source = image.getAttribute("data-local-image-source") ?? image.getAttribute("src") ?? ""
    const path = localMarkdownPath(source)
    if (
      !path ||
      image.getAttribute("data-local-image-resolved") === source ||
      image.getAttribute("data-local-image-pending") === source
    )
      return

    resolving = true
    image.setAttribute("data-local-image-source", source)
    image.setAttribute("data-local-image-pending", source)
    image.setAttribute("aria-busy", "true")
    image.removeAttribute("src")
    void resolve(path)
      .catch(() => undefined)
      .then((url) => {
        if (!active || !image.isConnected || image.getAttribute("data-local-image-source") !== source) return
        image.removeAttribute("data-local-image-pending")
        if (!url) {
          image.removeAttribute("aria-busy")
          onSettled?.()
          return
        }

        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          image.removeEventListener("load", finish)
          image.removeEventListener("error", finish)
          image.removeAttribute("aria-busy")
          if (active && image.isConnected && image.getAttribute("data-local-image-source") === source) onSettled?.()
        }
        image.addEventListener("load", finish)
        image.addEventListener("error", finish)
        cleanups.push(() => {
          image.removeEventListener("load", finish)
          image.removeEventListener("error", finish)
        })
        image.setAttribute("data-local-image-resolved", source)
        image.setAttribute("src", url)
        if (image.complete) finish()
      })
  })

  if (!resolving) return
  return () => {
    active = false
    cleanups.forEach((cleanup) => cleanup())
  }
}
