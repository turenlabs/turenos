import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import type { DesktopProductStorage } from "./storage/product"
import { setAppQuitting } from "./windows"

const { autoUpdater } = pkg

export function setupAutoUpdater(stop: () => Promise<void>, storage: DesktopProductStorage) {
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  const owner = "main/updater"
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      quitAndInstall: () => {
        // quitAndInstall closes all windows before emitting before-quit, so
        // flag the quit first to keep window ids persisted for restore.
        setAppQuitting()
        try {
          autoUpdater.quitAndInstall()
        } catch (error) {
          // The install failed and the app keeps running; clear the flag so
          // deliberate window closes prune ids again.
          setAppQuitting(false)
          throw error
        }
      },
    },
    persistence: {
      get: () => storage.getUpdaterReady(owner),
      set: (value: UpdaterReadyRecord) => storage.setUpdaterReady(owner, value),
      clear: () => storage.clearUpdaterReady(owner),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}
