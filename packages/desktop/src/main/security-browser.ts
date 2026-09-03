import { createHash } from "node:crypto"
import { BrowserWindow, session } from "electron"
import { externalHttpUrl } from "./external-link"

const MAX_SESSION_ID_LENGTH = 256
const windows = new Map<string, BrowserWindow>()

export type SecurityBrowserHandle = {
  sessionID: string
  windowID: number
  url: string
}

export function openSecurityBrowser(input: { sessionID: string; url: string }): SecurityBrowserHandle {
  const sessionID = requireSessionID(input.sessionID)
  const url = requireBrowserURL(input.url)
  const current = windows.get(sessionID)
  if (current && !current.isDestroyed()) {
    void current.loadURL(url)
    current.show()
    current.focus()
    return { sessionID, windowID: current.webContents.id, url }
  }

  const browserSession = session.fromPartition(partitionFor(sessionID))
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    title: "Security Browser",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: browserSession,
    },
  })

  windows.set(sessionID, window)
  window.on("closed", () => windows.delete(sessionID))
  window.webContents.setWindowOpenHandler(({ url: openedURL }) => {
    const safeURL = externalHttpUrl(openedURL)
    if (!safeURL) return { action: "deny" }
    void window.loadURL(safeURL)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, navigatedURL) => {
    if (!externalHttpUrl(navigatedURL)) event.preventDefault()
  })
  void window.loadURL(url)
  window.once("ready-to-show", () => window.show())

  return { sessionID, windowID: window.webContents.id, url }
}

export function navigateSecurityBrowser(input: { sessionID: string; url: string }): SecurityBrowserHandle {
  const sessionID = requireSessionID(input.sessionID)
  const url = requireBrowserURL(input.url)
  const window = windows.get(sessionID)
  if (!window || window.isDestroyed()) throw new Error("Security browser is not open")
  void window.loadURL(url)
  window.show()
  window.focus()
  return { sessionID, windowID: window.webContents.id, url }
}

export async function closeSecurityBrowser(sessionID: string) {
  const normalized = requireSessionID(sessionID)
  const window = windows.get(normalized)
  windows.delete(normalized)
  if (window && !window.isDestroyed()) window.close()
  await session.fromPartition(partitionFor(normalized)).clearStorageData()
}

export function closeAllSecurityBrowsers() {
  for (const sessionID of windows.keys()) void closeSecurityBrowser(sessionID)
}

function requireSessionID(value: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH)
    throw new Error("Security browser session ID is invalid")
  return value
}

function requireBrowserURL(value: string) {
  const url = externalHttpUrl(value)
  if (!url) throw new Error("Security browser requires an HTTP or HTTPS URL")
  return url
}

function partitionFor(sessionID: string) {
  return `security-${createHash("sha256").update(sessionID).digest("hex").slice(0, 32)}`
}
