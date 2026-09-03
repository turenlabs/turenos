import { externalHttpUrl } from "./external-link"

export const rendererProtocol = "forge-internal"
export const rendererHost = "renderer"
export const rendererOrigin = `${rendererProtocol}://${rendererHost}`

type RendererIpcEvent = {
  sender: {
    getURL(): string
    isDestroyed(): boolean
    readonly mainFrame: unknown
  }
  readonly senderFrame: unknown
}

export function isRendererUrl(
  value?: string,
  options: { html?: boolean; devURL?: string } = { devURL: process.env.ELECTRON_RENDERER_URL },
) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password) return false
  if (options.html && !url.pathname.toLowerCase().endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true

  const devURL = options.devURL ?? process.env.ELECTRON_RENDERER_URL
  if (!devURL || !URL.canParse(devURL)) return false
  const dev = new URL(devURL)
  if ((dev.protocol !== "http:" && dev.protocol !== "https:") || dev.username || dev.password) return false
  return url.origin === dev.origin
}

export function rendererCorsOrigins(devURL = process.env.ELECTRON_RENDERER_URL) {
  if (!devURL || !URL.canParse(devURL)) return [rendererOrigin]
  const dev = new URL(devURL)
  if ((dev.protocol !== "http:" && dev.protocol !== "https:") || dev.username || dev.password) return [rendererOrigin]
  return [rendererOrigin, dev.origin]
}

export function mainWindowNavigation(value: string, devURL = process.env.ELECTRON_RENDERER_URL) {
  if (isRendererUrl(value, { devURL })) return { action: "allow" as const }
  const external = externalHttpUrl(value)
  if (external) return { action: "external" as const, url: external }
  return { action: "deny" as const }
}

export function isTrustedRendererIpcEvent(
  event: RendererIpcEvent,
  ownsWindow: (sender: RendererIpcEvent["sender"]) => boolean,
  devURL = process.env.ELECTRON_RENDERER_URL,
) {
  try {
    return (
      !event.sender.isDestroyed() &&
      event.senderFrame === event.sender.mainFrame &&
      ownsWindow(event.sender) &&
      isRendererUrl(event.sender.getURL(), { devURL })
    )
  } catch {
    return false
  }
}
