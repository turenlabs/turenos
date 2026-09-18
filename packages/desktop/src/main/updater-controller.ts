import type { UpdaterSnapshot, UpdaterState } from "@turenlabs/app/updater"

export type { UpdaterSnapshot, UpdaterState } from "@turenlabs/app/updater"

export type UpdaterReadyRecord = { version: string }

/** How many releases behind latest the updater may track. */
export const UPDATER_MAX_LAG = 2

export type UpdaterBackend = {
  checkForUpdates(
    lag: number,
  ): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

type UpdaterPreference = {
  get(): number | undefined | Promise<number | undefined>
  set(value: number): void | Promise<void>
}

const normalizeLag = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(UPDATER_MAX_LAG, Math.trunc(value))) : 0

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  preference: UpdaterPreference
  stop: () => Promise<void>
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let lag = 0
  let pending: Promise<UpdaterState> | undefined
  const listeners = new Set<(snapshot: UpdaterSnapshot) => void>()

  const snapshot = (): UpdaterSnapshot => ({ state, lag })
  const emit = () => listeners.forEach((listener) => listener(snapshot()))

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    emit()
    return state
  }

  const check = () => {
    if (!input.enabled) return Promise.resolve(state)
    if (pending) return pending

    // A ready download goes stale when a newer release ships before the user
    // installs it. Revalidate the feed on every check so the pending install
    // tracks latest instead of stepping through skipped versions one at a time.
    const ready = state.status === "ready" ? state : undefined
    pending = (async () => {
      if (!ready) transition({ status: "checking" })
      const result = await input.backend.checkForUpdates(lag)
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }
      if (ready?.version === version) return ready

      transition({ status: "downloading", version })
      await input.backend.downloadUpdate()
      await input.persistence.set({ version })
      return transition({ status: "ready", version })
    })()
      .catch((error) =>
        // Keep a downloaded update installable when revalidation fails; only
        // surface an error when there is nothing ready to install.
        transition(
          ready ?? { status: "error", message: error instanceof Error ? error.message : String(error) },
        ),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return {
    getState: () => state,
    getLag: () => lag,
    subscribe(listener: (snapshot: UpdaterSnapshot) => void) {
      listeners.add(listener)
      listener(snapshot())
      return () => listeners.delete(listener)
    },
    async start() {
      lag = await Promise.resolve(input.preference.get()).then(
        (value) => normalizeLag(value ?? 0),
        () => 0,
      )
      const ready = await input.persistence.get()
      if (ready?.version === input.currentVersion) await input.persistence.clear()
      return check()
    },
    check,
    async setLag(next: number) {
      const normalized = normalizeLag(next)
      if (normalized === lag) return snapshot()
      lag = normalized
      await input.preference.set(lag)
      emit()
      if (!input.enabled) return snapshot()
      // An in-flight check resolved under the old lag; wait for it, then
      // re-resolve the target under the new track so a stale ready download
      // is replaced (or dropped) instead of installed.
      await pending
      await check()
      return snapshot()
    },
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const ready = state
      // The ready download may predate a newer release; installing whatever
      // the feed advertises now lands the user on latest in one hop.
      const latest = await check()
      const version = latest.status === "ready" ? latest.version : ready.version
      transition({ status: "installing", version })
      await input
        .stop()
        .then(() => {
          input.backend.quitAndInstall()
          transition({ status: "ready", version })
        })
        .catch((error) => {
          transition({ status: "ready", version })
          throw error
        })
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
