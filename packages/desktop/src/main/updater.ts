import { app, dialog, net } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { releaseTag, type GitHubRelease } from "./updater-feed"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import type { DesktopProductStorage } from "./storage/product"
import { setAppQuitting } from "./windows"

const { autoUpdater } = pkg

const RELEASES = "https://github.com/turenlabs/turenos/releases"
const RELEASES_API = "https://api.github.com/repos/turenlabs/turenos/releases"

/**
 * Picks the update feed for a lag preference. Lag 0 keeps the default GitHub
 * provider (`releases/latest`); lag > 0 resolves the tag that far back in the
 * release list and pins a generic provider at that tag's own feed assets
 * (`releases/download/<tag>/latest-*.yml` is uploaded with every release).
 */
async function updateFeed(lag: number) {
  if (lag <= 0) return { provider: "github" as const, owner: "turenlabs", repo: "turenos" }
  // net.fetch goes through Chromium's stack so corporate proxies are honored,
  // matching how electron-updater itself reaches GitHub.
  const response = await net.fetch(`${RELEASES_API}?per_page=10`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "turenos-updater" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Could not list TurenOS releases (HTTP ${response.status})`)
  const tag = releaseTag((await response.json()) as GitHubRelease[], lag)
  if (!tag) throw new Error("No published TurenOS releases found")
  return { provider: "generic" as const, url: `${RELEASES}/download/${tag}/` }
}

export function setupAutoUpdater(stop: () => Promise<void>, storage: DesktopProductStorage) {
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = `latest-${process.arch}`
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
      checkForUpdates: async (lag) => {
        autoUpdater.setFeedURL(await updateFeed(lag))
        return autoUpdater.checkForUpdates()
      },
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
    preference: {
      get: () => storage.getUpdaterLag(owner),
      set: (value: number) => storage.setUpdaterLag(owner, value),
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
