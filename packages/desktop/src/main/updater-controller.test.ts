import { describe, expect, test } from "bun:test"
import {
  createUpdaterController,
  type UpdaterBackend,
  type UpdaterReadyRecord,
  type UpdaterSnapshot,
} from "./updater-controller"

function setup(input?: {
  enabled?: boolean
  currentVersion?: string
  ready?: UpdaterReadyRecord
  lag?: number
  versions?: (string | null)[]
  failCheckAt?: number
  failDownloadAt?: number
}) {
  const calls: string[] = []
  const lags: number[] = []
  const versions = input?.versions ?? ["2.0.0"]
  let checks = 0
  let downloads = 0
  const backend: UpdaterBackend = {
    async checkForUpdates(lag) {
      calls.push("check")
      lags.push(lag)
      checks += 1
      if (input?.failCheckAt === checks) throw new Error("feed unavailable")
      const version = versions[Math.min(checks - 1, versions.length - 1)]
      return {
        isUpdateAvailable: version != null,
        updateInfo: { version: version ?? undefined },
      }
    },
    async downloadUpdate() {
      calls.push("download")
      downloads += 1
      if (input?.failDownloadAt === downloads) throw new Error("download failed")
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  let ready = input?.ready
  let lag = input?.lag
  const controller = createUpdaterController({
    enabled: input?.enabled ?? true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    preference: {
      get: () => lag,
      set: (value) => {
        lag = value
      },
    },
    stop: async () => {
      calls.push("stop")
    },
  })
  return { controller, calls, lags, getReady: () => ready, getLag: () => lag }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((snapshot) => states.push(snapshot.state))

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target through the updater cache on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("moves a ready target forward when a newer release ships", async () => {
    const app = setup({ versions: ["2.0.0", "3.0.0"] })
    await app.controller.start()

    await app.controller.check()

    expect(app.calls).toEqual(["check", "download", "check", "download"])
    expect(app.getReady()).toEqual({ version: "3.0.0" })
    expect(app.controller.getState()).toEqual({ status: "ready", version: "3.0.0" })
  })

  test("does not re-download while the ready version is still latest", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.check()

    expect(app.calls).toEqual(["check", "download", "check"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("keeps a downloaded update installable when revalidation fails", async () => {
    const app = setup({ failCheckAt: 2 })
    await app.controller.start()

    await app.controller.check()
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "check", "check", "stop", "install"])
  })

  test("installs the newer release when one ships after the download", async () => {
    const app = setup({ versions: ["2.0.0", "3.0.0"] })
    await app.controller.start()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((snapshot) => states.push(snapshot.state))

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "check", "download", "stop", "install"])
    expect(states.find((state) => state.status === "installing")).toEqual({
      status: "installing",
      version: "3.0.0",
    })
  })

  test("returns to ready when quitAndInstall returns without exiting", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "check", "stop", "install"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      preference: { get: () => undefined, set() {} },
      stop: async () => {
        throw new Error("stop failed")
      },
    })
    await failed.start()

    await expect(failed.install()).rejects.toThrow("stop failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("resolves update targets with the persisted lag preference", async () => {
    const app = setup({ lag: 2 })

    await app.controller.start()

    expect(app.lags).toEqual([2])
    expect(app.controller.getLag()).toBe(2)
  })

  test("setLag persists the preference and re-resolves the target", async () => {
    const app = setup({ versions: ["2.0.0", "3.0.0"] })
    await app.controller.start()
    const snapshots: { lag: number }[] = []
    app.controller.subscribe((snapshot) => snapshots.push(snapshot))

    await app.controller.setLag(1)

    expect(app.getLag()).toBe(1)
    expect(app.controller.getLag()).toBe(1)
    expect(app.calls).toEqual(["check", "download", "check", "download"])
    expect(app.lags).toEqual([0, 1])
    expect(app.getReady()).toEqual({ version: "3.0.0" })
    expect(snapshots.some((snapshot) => snapshot.lag === 1)).toBe(true)
  })

  test("setLag is a no-op when the preference is unchanged", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.setLag(0)

    expect(app.calls).toEqual(["check", "download"])
  })

  test("setLag clamps the preference into the supported range", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.setLag(9)
    expect(app.controller.getLag()).toBe(2)

    await app.controller.setLag(-3)
    expect(app.controller.getLag()).toBe(0)
  })

  // Contract: a disabled updater never touches the backend — checks report
  // disabled and changing the track only persists the preference.
  test("disabled updater reports disabled and never calls the backend", async () => {
    const app = setup({ enabled: false })

    await app.controller.start()
    expect(app.controller.getState()).toEqual({ status: "disabled" })
    await app.controller.check()
    await app.controller.setLag(1)

    expect(app.calls).toEqual([])
    expect(app.getLag()).toBe(1)
    expect(app.controller.getLag()).toBe(1)
  })

  // Contract: a failed check with nothing downloaded surfaces an error state
  // carrying the failure reason.
  test("surfaces a feed failure when nothing is downloaded", async () => {
    const app = setup({ failCheckAt: 1 })

    await app.controller.start()

    expect(app.controller.getState()).toEqual({ status: "error", message: "feed unavailable" })
    expect(app.getReady()).toBeUndefined()
  })

  // Contract: an error state is not terminal — the next check retries the
  // feed and can reach ready.
  test("recovers from an error on the next check", async () => {
    const app = setup({ failCheckAt: 1 })
    await app.controller.start()

    await app.controller.check()

    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  // Contract: non-Error rejections are stringified into the error state so
  // subscribers always see a readable message.
  test("stringifies non-Error rejections into the error message", async () => {
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: () => Promise.reject("socket hangup"),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      preference: { get: () => undefined, set() {} },
      stop: async () => {},
    })

    await controller.start()

    expect(controller.getState()).toEqual({ status: "error", message: "socket hangup" })
  })

  // Contract: when the feed reports nothing newer — explicitly unavailable,
  // already-current, or a malformed payload — the controller reports
  // up-to-date and drops any persisted target.
  test.each([
    { versions: [null] }, // feed says no update available
    { versions: ["1.0.0"] }, // feed only offers the running version
  ])("reports up-to-date and clears persistence for %#", async ({ versions }) => {
    const app = setup({ ready: { version: "2.0.0" }, versions })

    await app.controller.start()

    expect(app.controller.getState()).toEqual({ status: "up-to-date" })
    expect(app.getReady()).toBeUndefined()
    expect(app.calls).not.toContain("download")
  })

  // Contract: an update payload without a version is treated as no update —
  // a malformed feed must not trigger a download.
  test("treats an available result without a version as up-to-date", async () => {
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: {} }),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      preference: { get: () => undefined, set() {} },
      stop: async () => {},
    })

    await controller.start()

    expect(controller.getState()).toEqual({ status: "up-to-date" })
  })

  // Contract: install() is only legal while an update is ready — calling it
  // from any other state rejects instead of quitting mid-flow.
  test("rejects install() when no update is ready", async () => {
    const idle = setup()
    await expect(idle.controller.install()).rejects.toThrow("not ready")
    expect(idle.calls).toEqual([])

    const failed = setup({ failCheckAt: 1 })
    await failed.controller.start()
    await expect(failed.controller.install()).rejects.toThrow("not ready")
  })

  // Contract: a downloaded update stays installable when the feed retracts
  // the offer at install time — the file is already on disk and is still an
  // upgrade for the running version.
  test("installs the downloaded update when the feed retracts the offer", async () => {
    const app = setup({ versions: ["2.0.0", null] })
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "check", "stop", "install"])
  })

  // Contract: a failed re-download keeps the previous ready update
  // installable and does not overwrite the persisted record.
  test("keeps the previous ready update when the newer download fails", async () => {
    const app = setup({ versions: ["2.0.0", "3.0.0"], failDownloadAt: 2 })
    await app.controller.start()

    await app.controller.check()

    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
    expect(app.getReady()).toEqual({ version: "2.0.0" })
  })

  // Contract: a quitAndInstall failure propagates to the caller and returns
  // the controller to ready so the user can retry.
  test("propagates quitAndInstall failures and returns to ready", async () => {
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {
          throw new Error("cannot install")
        },
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      preference: { get: () => undefined, set() {} },
      stop: async () => {},
    })
    await controller.start()

    await expect(controller.install()).rejects.toThrow("cannot install")
    expect(controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  // Contract: subscribe delivers the current snapshot immediately, and the
  // returned function detaches the listener so later transitions are not
  // delivered to it.
  test("delivers the current snapshot on subscribe and stops after unsubscribe", async () => {
    const app = setup()
    const snapshots: UpdaterSnapshot[] = []
    const unsubscribe = app.controller.subscribe((snapshot) => snapshots.push(snapshot))

    expect(snapshots).toEqual([{ state: { status: "idle" }, lag: 0 }])

    await app.controller.start()
    unsubscribe()
    const delivered = snapshots.length
    await app.controller.setLag(1)

    expect(snapshots.length).toBe(delivered)
    expect(snapshots.every((snapshot) => snapshot.lag === 0)).toBe(true)
  })

  // Contract: a revalidation that confirms the pending version does not
  // notify subscribers — nothing changed, so the UI must not flicker.
  test("does not emit when revalidation confirms the same ready version", async () => {
    const app = setup()
    await app.controller.start()
    const snapshots: UpdaterSnapshot[] = []
    app.controller.subscribe((snapshot) => snapshots.push(snapshot))

    await app.controller.check()

    expect(snapshots).toEqual([{ state: { status: "ready", version: "2.0.0" }, lag: 0 }])
  })

  // Contract: switching tracks while a check is in flight waits for that
  // check to finish, then re-resolves under the new track — the controller
  // never settles on a target resolved under a stale preference.
  test("setLag re-resolves under the new track after an in-flight check", async () => {
    const lags: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let lag = 0
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async (requested) => {
          lags.push(requested)
          await gate
          return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
        },
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      preference: {
        get: () => 0,
        set: (value) => {
          lag = value
        },
      },
      stop: async () => {},
    })

    const started = controller.start()
    while (lags.length === 0) await new Promise((resolve) => setImmediate(resolve))
    const switched = controller.setLag(1)
    release()
    await Promise.all([started, switched])

    expect(lags).toEqual([0, 1])
    expect(lag).toBe(1)
    expect(controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  // Contract: switching to a track with nothing newer drops the pending
  // download — a ready target from another track is not installed.
  test("setLag to a track with no update drops the pending download", async () => {
    const app = setup({ versions: ["3.0.0", null] })
    await app.controller.start()
    expect(app.controller.getState()).toEqual({ status: "ready", version: "3.0.0" })

    await app.controller.setLag(2)

    expect(app.lags).toEqual([0, 2])
    expect(app.controller.getState()).toEqual({ status: "up-to-date" })
    expect(app.getReady()).toBeUndefined()
  })

  // Contract: a stored preference outside the supported range is clamped at
  // load, not honored blindly.
  test.each([
    [7, 2],
    [-1, 0],
    [2.9, 2],
  ])("clamps a persisted lag of %f to %i at start", async (persisted, expected) => {
    const app = setup({ lag: persisted })

    await app.controller.start()

    expect(app.controller.getLag()).toBe(expected)
    expect(app.lags).toEqual([expected])
  })

  // Contract: setLag normalizes arbitrary input into the supported range —
  // out-of-range clamps, fractional truncates, non-finite falls back to
  // latest — and persists the normalized value. Basis: the supported range
  // is 0..2 and latest (0) is the safe default for garbage input.
  test.each([
    [9, 2],
    [-3, 0],
    [1.9, 1],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])("setLag(%s) normalizes to %i", async (input, expected) => {
    const app = setup()
    await app.controller.start()
    // Establish a known non-default persisted value so a no-op setLag still
    // leaves persistence deterministic.
    await app.controller.setLag(1)

    await app.controller.setLag(input)

    expect(app.controller.getLag()).toBe(expected)
    expect(app.getLag()).toBe(expected)
  })
})
