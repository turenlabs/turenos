import { resolveThemeVariant } from "@turenlabs/ui/theme/resolve"
import type { DesktopTheme } from "@turenlabs/ui/theme/types"
import oc2ThemeJson from "../../../ui/src/theme/themes/oc-2.json"
import { randomUUID } from "node:crypto"
import { app, BrowserWindow, dialog, net, nativeImage, nativeTheme, protocol, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { exportDebugLogs, write as writeLog } from "./logging"
import type { DesktopProductStorage, WindowGeometry } from "./storage/product"
import { createUnresponsiveSampler } from "./unresponsive"
import { createWindowRegistry } from "./window-registry"
import { safeWindowURL } from "./window-state"
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from "./storage/product"
import {
  isRendererUrl,
  isTrustedRendererIpcEvent,
  mainWindowNavigation,
  rendererHost,
  rendererProtocol,
  rendererDocumentPolicy,
  rendererDocumentPolicyHeader,
  rendererResponseHeaders,
} from "./window-security"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const clipboardWritePermission = "clipboard-sanitized-write"
const notificationPermission = "notifications"
const rendererPermissions = new Set([clipboardWritePermission, notificationPermission])
const oc2Theme = oc2ThemeJson as DesktopTheme
const oc2Background = {
  light: resolveThemeVariant(oc2Theme.light, false)["background-base"],
  dark: resolveThemeVariant(oc2Theme.dark, true)["background-base"],
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  setAppQuitting()
  app.relaunch()
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const windowIDs = new WeakMap<BrowserWindow, string>()
let storage: DesktopProductStorage | undefined
let sessionEndHandler: ((event: { preventDefault(): void }) => void) | undefined
let registry: ReturnType<typeof createWindowRegistry<BrowserWindow>> | undefined
let storedWindowIDs: string[] = []
let storedPinchZoomEnabled = false
let appQuitting = false
let windowRegistryWrite = Promise.resolve()
const geometryWrites = new Map<string, Promise<void>>()
const geometryTimers = new Map<string, NodeJS.Timeout>()
const titlebarHeight = 40
const maxZoomLevel = 10
const minZoomLevel = 0.2

export function setRelaunchHandler(handler: () => void) {
  relaunchHandler = handler
}

export function setAppQuitting(quitting = true) {
  appQuitting = quitting
  registry?.setQuitting(quitting)
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  getMainWindows().forEach((win) => {
    win.setBackgroundColor(color)
    if (process.platform === "darwin") win.invalidateShadow()
  })
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return oc2Background[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  // macOS draws the window frame hairline and shadow using the NSWindow
  // appearance, which follows nativeTheme rather than the rendered content.
  // Align it with the app theme so a light app on a dark system does not get
  // the dark-appearance border and shadow. A "system" scheme must map to
  // "system" (not the resolved mode) or prefers-color-scheme stops tracking
  // OS appearance changes in the renderer.
  if (process.platform === "darwin") nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export async function setPinchZoomEnabled(owner: number, enabled: boolean) {
  if (!storage) throw new Error("Desktop product Storage is not initialized")
  await storage.setPinchZoomEnabled(owner, enabled)
  storedPinchZoomEnabled = enabled
  for (const win of getMainWindows()) {
    pinchZoomEnabled.set(win, enabled)
    win.webContents.send("pinch-zoom-enabled-changed", enabled)
    if (!enabled && win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  }
}

export async function getPinchZoomEnabled(owner: number) {
  if (!storage) throw new Error("Desktop product Storage is not initialized")
  storedPinchZoomEnabled = await storage.getPinchZoomEnabled(owner)
  return storedPinchZoomEnabled
}

export function getWindowID(win: BrowserWindow) {
  return windowIDs.get(win)
}

export function getMainWindows() {
  return BrowserWindow.getAllWindows().filter((win) => windowIDs.has(win))
}

export function getLastFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && windowIDs.has(focused)) return focused
  const win = registry?.lastFocused()
  if (!win || win.isDestroyed()) return null
  return win
}

export async function initializeWindows(productStorage: DesktopProductStorage) {
  storage = productStorage
  const owner = "main/windows"
  ;[storedWindowIDs, storedPinchZoomEnabled] = await Promise.all([
    storage.getWindowIds(owner),
    storage.getPinchZoomEnabled(owner),
  ])
  registry = createWindowRegistry<BrowserWindow>({
    read: () => storedWindowIDs,
    write: (ids) => {
      storedWindowIDs = ids
      windowRegistryWrite = windowRegistryWrite
        .then(() => storage?.setWindowIds(owner, ids))
        .catch((error) => writeLog("window", "failed to persist window registry", { error }, "error"))
    },
    cleanup: (id) => {
      windowRegistryWrite = windowRegistryWrite
        .then(async () => {
          const timer = geometryTimers.get(id)
          if (timer) clearTimeout(timer)
          geometryTimers.delete(id)
          await geometryWrites.get(id)
          await storage?.removeWindow(`main/window/${id}`, id)
          geometryWrites.delete(id)
        })
        .catch((error) => writeLog("window", "failed to remove window state", { error }, "error"))
    },
  })
  registry.setQuitting(appQuitting)
}

export function setSessionEndHandler(handler: (event: { preventDefault(): void }) => void) {
  sessionEndHandler = handler
}

export async function restoreMainWindows() {
  if (!registry || !storage) throw new Error("Desktop product Storage is not initialized")
  const ids = registry.persisted()
  return Promise.all((ids.length ? ids : [randomUUID()]).map((id) => createMainWindow(id)))
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export async function createMainWindow(id: string = randomUUID()) {
  if (!registry || !storage) throw new Error("Desktop product Storage is not initialized")
  const state = (await storage.getWindowGeometry(`main/window/${id}`, id)) ?? {
    width: 1280,
    height: 800,
    maximized: false,
    fullScreen: false,
  }

  const mode = tone()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    // Belt to the storage layer's braces: even if a collapsed geometry reaches
    // here, the OS will not shrink the window below something usable.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    title: "TurenOS",
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  wireWindowNavigation(win)
  allowRendererPermissions(win)
  wireWindowRecovery(win, id)

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    if (
      details.resourceType === "xhr" &&
      details.webContents &&
      details.frame &&
      isTrustedRendererIpcEvent({ sender: details.webContents, senderFrame: details.frame }, (sender) =>
        ownsMainWindow(sender as WebContents),
      )
    ) {
      // Preserve direct remote-server connections without granting CORS to navigated content.
      upsertKeyValue(responseHeaders, "Access-Control-Allow-Origin", ["*"])
    }
    addRendererDocumentPolicyHeader(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  registerWindow(win, id)
  wireWindowGeometry(win, id, state)
  loadWindow(win, "index.html")
  wireZoom(win)

  let revealed = false
  const reveal = () => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    clearTimeout(revealTimer)
    if (state.maximized) win.maximize()
    if (state.fullScreen) win.setFullScreen(true)
    win.show()
  }
  const revealTimer = setTimeout(() => {
    writeLog("window", "showing window after renderer readiness timeout", { window: id }, "warn")
    reveal()
  }, 10_000)
  win.once("ready-to-show", () => {
    reveal()
  })
  win.webContents.once("did-finish-load", () => setTimeout(reveal, 250))
  win.once("closed", () => clearTimeout(revealTimer))

  return win
}

function registerWindow(win: BrowserWindow, id: string) {
  windowIDs.set(win, id)
  registry?.register(id, win)

  win.on("focus", () => registry?.focused(id))
  // Windows never emits before-quit on OS shutdown/logoff, but each window
  // gets a vetoable query before session-end. Hold it until persistence drains.
  win.on("query-session-end", (event) => {
    registry?.setQuitting()
    sessionEndHandler?.(event)
  })
  win.on("session-end", () => registry?.setQuitting())
  win.on("closed", () => registry?.closed(id))
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    try {
      const range = request.headers.get("range")
      const response = await net.fetch(pathToFileURL(file).toString(), {
        headers: range ? { range } : undefined,
      })
      if (response.status >= 400) {
        writeLog(
          "protocol",
          "fetch failed",
          {
            url: request.url,
            file,
            status: response.status,
            statusText: response.statusText,
          },
          "error",
        )
      }
      return addDocumentPolicy(response, file)
    } catch (error) {
      writeLog("protocol", "fetch error", { url: request.url, file, error }, "error")
      return new Response("Not found", { status: 404 })
    }
  })
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}?v=${encodeURIComponent(app.getVersion())}`)
}

function wireWindowNavigation(win: BrowserWindow) {
  const navigate = (event: { preventDefault(): void; readonly url: string; readonly isMainFrame: boolean }) => {
    if (!event.isMainFrame) {
      event.preventDefault()
      return
    }
    const navigation = mainWindowNavigation(event.url)
    if (navigation.action === "allow") return
    event.preventDefault()
    if (navigation.action === "external") void shell.openExternal(navigation.url)
  }

  win.webContents.on("will-frame-navigate", navigate)
  win.webContents.on("will-redirect", navigate)
  win.webContents.setWindowOpenHandler(({ url }) => {
    const navigation = mainWindowNavigation(url)
    if (navigation.action === "external") void shell.openExternal(navigation.url)
    return { action: "deny" }
  })
}

function wireWindowRecovery(win: BrowserWindow, name: string) {
  let showing = false
  let rendererRecoveryAttempts = 0
  const sampler = createUnresponsiveSampler(win, name)

  const reloadRenderer = (reason: string) => {
    if (appQuitting || rendererRecoveryAttempts > 0 || win.isDestroyed()) return false
    rendererRecoveryAttempts += 1
    writeLog("window", "reloading renderer after startup failure", { window: name, reason }, "warn")
    win.webContents.reload()
    return true
  }

  const handle = async (button: string | undefined, wait: boolean) => {
    if (button === "Export Logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (button === "Relaunch") {
      sampler.stopAndFlush()
      relaunchHandler()
      return false
    }
    if (button === "Quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(buttons[result.response], wait)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        errorDescription,
        validatedURL,
        currentURL: safeWindowURL(win),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    if (reloadRenderer(`${event}: ${errorCode} ${errorDescription}`)) return
    void show(
      "TurenOS failed to load",
      [`Window: ${name}`, `URL: ${validatedURL}`, `Error: ${errorCode} ${errorDescription}`].join("\n"),
      false,
    )
  }

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog("window", "renderer process gone", { window: name, currentURL: safeWindowURL(win), details }, "error")
    if (reloadRenderer(`render-process-gone: ${details.reason}`)) return
    void show(
      "TurenOS window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  win.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: safeWindowURL(win) }, "error")
    sampler.start()
    void show("TurenOS is not responding", "You can relaunch the app, open the logs, or keep waiting.", true)
  })
  win.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: safeWindowURL(win) }, "error")
    sampler.stopAndFlush()
  })
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", { window: name, level, message, line, sourceId })
    }
  })
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, preloadPath, error }, "error")
  })
}

function wireWindowGeometry(win: BrowserWindow, id: string, initial: WindowGeometry) {
  const persist = () => {
    if (!storage || win.isDestroyed()) return
    const bounds = win.getNormalBounds()
    const geometry = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    }
    const previous = geometryWrites.get(id) ?? Promise.resolve()
    geometryWrites.set(
      id,
      previous
        .then(() => storage?.setWindowGeometry(`main/window/${id}`, id, geometry))
        .catch((error) => writeLog("window", "failed to persist window geometry", { id, error }, "error")),
    )
  }
  const schedule = () => {
    const current = geometryTimers.get(id)
    if (current) clearTimeout(current)
    geometryTimers.set(
      id,
      setTimeout(() => {
        geometryTimers.delete(id)
        persist()
      }, 150),
    )
  }

  ;["move", "resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"].forEach((event) =>
    win.on(event as "move", schedule),
  )
  win.on("close", () => {
    const current = geometryTimers.get(id)
    if (current) clearTimeout(current)
    geometryTimers.delete(id)
    persist()
  })

  if (initial.width <= 0 || initial.height <= 0) schedule()
}

export async function flushWindowState() {
  geometryTimers.forEach((timer, id) => {
    clearTimeout(timer)
    geometryTimers.delete(id)
    const win = BrowserWindow.getAllWindows().find((candidate) => windowIDs.get(candidate) === id)
    if (!win || win.isDestroyed()) return
    const bounds = win.getNormalBounds()
    const previous = geometryWrites.get(id) ?? Promise.resolve()
    geometryWrites.set(
      id,
      previous
        .then(() =>
          storage?.setWindowGeometry(`main/window/${id}`, id, {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            maximized: win.isMaximized(),
            fullScreen: win.isFullScreen(),
          }),
        )
        .catch((error) => writeLog("window", "failed to flush window geometry", { id, error }, "error")),
    )
  })
  await Promise.all([windowRegistryWrite, ...geometryWrites.values()])
}

function addDocumentPolicy(response: Response, file: string) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: rendererResponseHeaders(response.headers, file),
  })
}

function allowRendererPermissions(win: BrowserWindow) {
  const webContentsId = win.webContents.id

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        webContents.id === webContentsId,
    )
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (webContents && webContents.id !== webContentsId) return false
    return isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin)
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

function addRendererDocumentPolicyHeader(value: string, headers: Record<string, any>) {
  if (isRendererUrl(value, { html: true }))
    upsertKeyValue(headers, rendererDocumentPolicyHeader, [rendererDocumentPolicy])
}

export function assertTrustedRendererEvent(event: IpcMainEvent | IpcMainInvokeEvent, fail = true) {
  const trusted = isTrustedRendererIpcEvent(event, (sender) => ownsMainWindow(sender as WebContents))
  if (!trusted && fail) throw new Error("Untrusted renderer IPC sender")
  return trusted
}

function ownsMainWindow(sender: WebContents) {
  const win = BrowserWindow.fromWebContents(sender)
  return Boolean(win && windowIDs.has(win))
}

function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, storedPinchZoomEnabled)
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  })
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  win.webContents.send("zoom-factor-changed", win.webContents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
