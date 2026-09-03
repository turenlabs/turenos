import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@turenlabs/app/desktop-menu"

import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getWindowID, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { externalHttpUrl } from "./external-link"
import {
  closeAllSecurityBrowsers,
  closeSecurityBrowser,
  navigateSecurityBrowser,
  openSecurityBrowser,
} from "./security-browser"
import { IS_DEV } from "./constants"
import type { ProfilerController } from "./profiler"
import type { DesktopStorage } from "./storage/bridge"
import { rendererStoreName } from "./renderer-store-name"
import { TrustedIpc } from "./trusted-ipc"

// Keep registration syntax familiar while enforcing one trust gate for every channel.
const ipcMain = TrustedIpc

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  profiler: ProfilerController
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: (owner: number) => Promise<string | null | undefined>
  setDefaultServerUrl: (owner: number, url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: (owner: number) => Promise<boolean>
  finishFirstLaunchOnboarding: (owner: number) => Promise<void>
  isOldLayoutEligible: (owner: number) => Promise<boolean>
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  storage: DesktopStorage
  releaseProductStorage: (owner: number) => void
  getPinchZoomEnabled: (owner: number) => Promise<boolean>
  setPinchZoomEnabled: (owner: number, enabled: boolean) => Promise<void>
  getWindowLastActiveUrl: (
    owner: number,
    id: string,
    legacy: { readable: boolean; value: string | null },
  ) => Promise<string>
  setWindowLastActiveUrl: (owner: number, id: string, value: string) => Promise<void>
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  const storageOwners = new Set<number>()
  const storageOwner = (event: IpcMainInvokeEvent) => {
    const id = event.sender.id
    if (storageOwners.has(id)) return id
    storageOwners.add(id)
    event.sender.once("destroyed", () => {
      storageOwners.delete(id)
      deps.storage.release(id)
      deps.releaseProductStorage(id)
    })
    return id
  }
  app.once("will-quit", updaterSubscriptions.clear)
  app.once("will-quit", closeAllSecurityBrowsers)

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", (event: IpcMainInvokeEvent) => deps.getDefaultServerUrl(storageOwner(event)))
  ipcMain.handle("set-default-server-url", (event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(storageOwner(event), url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", (event: IpcMainInvokeEvent) =>
    deps.isFirstLaunchOnboardingPending(storageOwner(event)),
  )
  ipcMain.handle("finish-first-launch-onboarding", (event: IpcMainInvokeEvent) =>
    deps.finishFirstLaunchOnboarding(storageOwner(event)),
  )
  ipcMain.handle("is-old-layout-eligible", (event: IpcMainInvokeEvent) => deps.isOldLayoutEligible(storageOwner(event)))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("security-browser-open", (_event: IpcMainInvokeEvent, input: { sessionID: string; url: string }) =>
    openSecurityBrowser(input),
  )
  ipcMain.handle("security-browser-navigate", (_event: IpcMainInvokeEvent, input: { sessionID: string; url: string }) =>
    navigateSecurityBrowser(input),
  )
  ipcMain.handle("security-browser-close", (_event: IpcMainInvokeEvent, sessionID: string) =>
    closeSecurityBrowser(sessionID),
  )

  // Dev-only CPU profiler. `IS_DEV` folds to a literal, so these channels are
  // not merely refused in a shipped build - they are never registered, and the
  // block drops out of the bundle.
  if (IS_DEV) {
    const profilerSubscriptions = new Map<number, () => void>()
    const releaseProfiler = (id: number) => {
      profilerSubscriptions.get(id)?.()
      profilerSubscriptions.delete(id)
    }
    app.once("will-quit", () => {
      for (const id of [...profilerSubscriptions.keys()]) releaseProfiler(id)
    })

    ipcMain.handle("profiler-status", () => deps.profiler.status())
    ipcMain.handle("profiler-start", () => deps.profiler.start())
    ipcMain.handle("profiler-stop", () => deps.profiler.stop())
    ipcMain.handle("profiler-subscribe", (event: IpcMainInvokeEvent) => {
      const id = event.sender.id
      releaseProfiler(id)
      profilerSubscriptions.set(
        id,
        deps.profiler.subscribe((state) => {
          if (event.sender.isDestroyed()) return releaseProfiler(id)
          event.sender.send("profiler-state", state)
        }),
      )
      event.sender.once("destroyed", () => releaseProfiler(id))
    })
    ipcMain.handle("profiler-unsubscribe", (event: IpcMainInvokeEvent) => releaseProfiler(event.sender.id))
  }
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", (event: IpcMainInvokeEvent, name: string, key: string) =>
    deps.storage.get(storageOwner(event), rendererStoreName(name), key),
  )
  ipcMain.handle("store-set", (event: IpcMainInvokeEvent, name: string, key: string, value: string) =>
    deps.storage.set(storageOwner(event), rendererStoreName(name), key, value),
  )
  ipcMain.handle("store-delete", (event: IpcMainInvokeEvent, name: string, key: string) =>
    deps.storage.remove(storageOwner(event), rendererStoreName(name), key),
  )
  ipcMain.handle("store-clear", (event: IpcMainInvokeEvent, name: string) =>
    deps.storage.clear(storageOwner(event), rendererStoreName(name)),
  )
  ipcMain.handle("store-keys", (event: IpcMainInvokeEvent, name: string) =>
    deps.storage.keys(storageOwner(event), rendererStoreName(name)),
  )
  ipcMain.handle("store-length", (event: IpcMainInvokeEvent, name: string) =>
    deps.storage.length(storageOwner(event), rendererStoreName(name)),
  )

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: unknown) => {
    const external = externalHttpUrl(url)
    if (!external) return
    void shell.openExternal(external)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle(
    "get-window-last-active-url",
    (event: IpcMainInvokeEvent, legacy: { readable: boolean; value: string | null }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error("Window not found")
      const id = getWindowID(win)
      if (!id) throw new Error("Window ID not found")
      return deps.getWindowLastActiveUrl(storageOwner(event), id, legacy)
    },
  )
  ipcMain.handle("set-window-last-active-url", (event: IpcMainInvokeEvent, value: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return deps.setWindowLastActiveUrl(storageOwner(event), id, value)
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", (event: IpcMainInvokeEvent) => deps.getPinchZoomEnabled(storageOwner(event)))
  ipcMain.handle("set-pinch-zoom-enabled", (event: IpcMainInvokeEvent, enabled: boolean) =>
    deps.setPinchZoomEnabled(storageOwner(event), enabled),
  )
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
