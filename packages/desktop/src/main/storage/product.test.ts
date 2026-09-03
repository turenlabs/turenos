import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageHttpError } from "./client"
import type { StorageMigrationReceipt, StorageRemote, StorageState } from "./client"
import { createDesktopProductStorage } from "./product"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-desktop-product-"))
  roots.push(root)
  return { root, state: remote() }
}

describe("Desktop product Storage", () => {
  test("atomically imports typed settings, updater, and window geometry without mutating legacy inputs", async () => {
    const app = await setup()
    const geometry = JSON.stringify({ x: 11, y: 22, width: 1200, height: 700, isMaximized: true })
    await writeFile(join(app.root, "window-state-first.json"), geometry)
    const settings = {
      defaultServerUrl: "http://127.0.0.1:4096",
      firstLaunchOnboardingComplete: true,
      oldLayoutEligible: true,
      wslServers: { servers: [{ id: "wsl:Debian", distro: "Debian" }] },
      pinchZoomEnabled: true,
      windowIds: ["first"],
    }
    const updater = { ready: { version: "2.0.0" } }
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: (name) => ({ store: name === "forge.settings" ? settings : updater }),
      oldLayoutEligible: () => false,
    })

    await storage.ready()
    expect(await storage.getDefaultServerUrl("main")).toBe("http://127.0.0.1:4096")
    expect(await storage.isFirstLaunchOnboardingPending("main")).toBe(false)
    expect(await storage.isOldLayoutEligible("main")).toBe(true)
    expect(await storage.getWslServers("main")).toEqual([{ id: "wsl:Debian", distro: "Debian" }])
    expect(await storage.getPinchZoomEnabled("main")).toBe(true)
    expect(await storage.getWindowIds("main")).toEqual(["first"])
    expect(await storage.getUpdaterReady("main")).toEqual({ version: "2.0.0" })
    expect(await storage.getWindowGeometry("main", "first")).toEqual({
      x: 11,
      y: 22,
      width: 1200,
      height: 700,
      maximized: true,
      fullScreen: false,
    })
    expect(settings.defaultServerUrl).toBe("http://127.0.0.1:4096")
    expect(updater.ready).toEqual({ version: "2.0.0" })
    expect(await readFile(join(app.root, "window-state-first.json"), "utf8")).toBe(geometry)
    expect([...app.state.receipts.keys()].sort()).toEqual([
      "desktop.legacy.product-settings.v1",
      "desktop.legacy.updater-ready.v1",
      expect.stringMatching(/^desktop\.legacy\.window-state\.v1\./),
    ])
  })

  test("keeps Storage as authority across restart when retained legacy inputs become stale", async () => {
    const app = await setup()
    const legacy = { defaultServerUrl: "http://legacy.example" }
    const first = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: (name) => ({ store: name === "forge.settings" ? legacy : {} }),
      oldLayoutEligible: () => false,
    })
    await first.ready()
    await first.getDefaultServerUrl("renderer")
    await first.setDefaultServerUrl("renderer", "http://current.example")
    legacy.defaultServerUrl = "http://stale.example"

    const restarted = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: (name) => ({ store: name === "forge.settings" ? legacy : {} }),
      oldLayoutEligible: () => true,
    })
    await restarted.ready()

    expect(await restarted.getDefaultServerUrl("renderer")).toBe("http://current.example")
    expect(await restarted.isOldLayoutEligible("renderer")).toBe(false)
    expect(app.state.imports.filter((item) => item === "desktop.legacy.product-settings.v1")).toHaveLength(1)
  })

  test("keeps a fresh profile onboarding pending until explicit completion", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: {} }),
      oldLayoutEligible: () => false,
    })
    await storage.ready()

    expect(await storage.isFirstLaunchOnboardingPending("renderer")).toBe(true)
    await storage.finishFirstLaunchOnboarding("renderer")
    expect(await storage.isFirstLaunchOnboardingPending("renderer")).toBe(false)
  })

  test("does not record a settings receipt when reading the legacy source fails", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: (name) => {
        if (name === "forge.settings") throw new Error("legacy settings unreadable")
        return { store: {} }
      },
      oldLayoutEligible: () => false,
    })

    await expect(storage.ready()).rejects.toThrow("legacy settings unreadable")
    expect(app.state.receipts.has("desktop.legacy.product-settings.v1")).toBe(false)
  })

  test("does not record a window receipt when the matching legacy file cannot be read", async () => {
    const app = await setup()
    await mkdir(join(app.root, "window-state-unreadable.json"))
    const warnings: unknown[] = []
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: {} }),
      oldLayoutEligible: () => false,
      warn: (_message, error) => warnings.push(error),
    })

    await storage.ready()
    expect(warnings).toHaveLength(1)
    expect([...app.state.receipts.keys()].some((name) => name.includes("window-state.v1"))).toBe(false)
  })

  test("keeps renderer URL import receipt-free when localStorage was unreadable", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: {} }),
      oldLayoutEligible: () => false,
    })
    await storage.ready()

    expect(await storage.getWindowLastActiveUrl(1, "one", { readable: false, value: null })).toBe("/")
    expect([...app.state.receipts.keys()].some((name) => name.includes("renderer-last-active-url"))).toBe(false)
    expect(await storage.getWindowLastActiveUrl(1, "one", { readable: true, value: "/session/abc" })).toBe(
      "/session/abc",
    )
    expect([...app.state.receipts.keys()].some((name) => name.includes("renderer-last-active-url"))).toBe(true)
  })

  test("serializes two renderer intents with coherent committed revisions", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: { pinchZoomEnabled: false } }),
      oldLayoutEligible: () => false,
    })
    await storage.ready()
    expect(await storage.getPinchZoomEnabled(1)).toBe(false)
    expect(await storage.getPinchZoomEnabled(2)).toBe(false)

    const original = app.state.api.set
    const started = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    app.state.api.set = async (scope, key, value, expectedRevision) => {
      if (value === "true") {
        started.resolve()
        await blocked.promise
      }
      return original(scope, key, value, expectedRevision)
    }
    const first = storage.setPinchZoomEnabled(1, true)
    await started.promise
    const second = storage.setPinchZoomEnabled(2, false)
    blocked.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(await storage.getPinchZoomEnabled(1)).toBe(false)
  })

  test("serializes concurrent same-owner writes and drains the latest value", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: {} }),
      oldLayoutEligible: () => false,
    })
    await storage.ready()
    const original = app.state.api.set
    const started = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    app.state.api.set = async (scope, key, value, expectedRevision) => {
      if (value === JSON.stringify("/first")) {
        started.resolve()
        await blocked.promise
      }
      return original(scope, key, value, expectedRevision)
    }

    const first = storage.setWindowLastActiveUrl(1, "one", "/first")
    await started.promise
    const second = storage.setWindowLastActiveUrl(1, "one", "/second")
    const drained = storage.drain()
    blocked.resolve()

    await expect(Promise.all([first, second, drained])).resolves.toEqual([undefined, undefined, undefined])
    expect(await storage.getWindowLastActiveUrl(1, "one", { readable: false, value: null })).toBe("/second")
  })

  test("isolates window geometry and last-active URLs by opaque window identity", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: {} }),
      oldLayoutEligible: () => false,
    })
    await storage.ready()
    await storage.setWindowGeometry("one", "one", {
      width: 900,
      height: 600,
      maximized: false,
      fullScreen: false,
    })
    await storage.setWindowLastActiveUrl("one", "one", "/one")
    await storage.setWindowLastActiveUrl("two", "two", "/two")

    expect(await storage.getWindowGeometry("one", "one")).toMatchObject({ width: 900, height: 600 })

    // A collapsed window reads to the user as a failed launch. A real 1x32 row
    // survived a SIGKILL mid-teardown and reopened as an invisible sliver, so
    // neither writing nor reading one may succeed.
    await storage.setWindowGeometry("one", "one", {
      x: 0,
      y: 873,
      width: 1,
      height: 32,
      maximized: false,
      fullScreen: false,
    })
    expect(await storage.getWindowGeometry("one", "one")).toMatchObject({ width: 900, height: 600 })

    // Maximized and fullscreen windows legitimately report odd bounds, so they
    // are exempt from the floor.
    await storage.setWindowGeometry("one", "one", {
      width: 1,
      height: 1,
      maximized: true,
      fullScreen: false,
    })
    expect(await storage.getWindowGeometry("one", "one")).toMatchObject({ maximized: true })
    expect(await storage.getWindowGeometry("two", "two")).toBeUndefined()
    expect(await storage.getWindowLastActiveUrl("one", "one", { readable: false, value: null })).toBe("/one")
    expect(await storage.getWindowLastActiveUrl("two", "two", { readable: false, value: null })).toBe("/two")
  })

  test("fails closed and preserves malformed Product Storage values", async () => {
    const app = await setup()
    const storage = createDesktopProductStorage({
      remote: app.state.api,
      userDataPath: app.root,
      legacy: () => ({ store: {} }),
      oldLayoutEligible: () => false,
    })
    await storage.ready()
    await app.state.api.set("desktop/store/product-state-v1", "pinch-zoom-enabled", "not-json")

    await expect(storage.getPinchZoomEnabled("main")).rejects.toThrow("Invalid Desktop product Storage value")
    expect(await app.state.api.get("desktop/store/product-state-v1", "pinch-zoom-enabled")).toMatchObject({
      value: "not-json",
    })
  })
})

function remote() {
  const states = new Map<string, StorageState>()
  const receipts = new Map<string, StorageMigrationReceipt>()
  const imports: string[] = []
  const address = (scope: string, key: string) => `${scope}\0${key}`
  const api: StorageRemote = {
    get: async (scope, key) => states.get(address(scope, key)),
    list: async (scope) => [...states.values()].filter((item) => item.scope === scope),
    set: async (scope, key, value, expectedRevision) => {
      const current = states.get(address(scope, key))
      if (expectedRevision !== undefined && expectedRevision !== (current?.revision ?? null)) {
        throw new StorageHttpError(409)
      }
      const state = {
        scope,
        key,
        value,
        revision: (current?.revision ?? 0) + 1,
        timeCreated: current?.timeCreated ?? 1,
        timeUpdated: (current?.timeUpdated ?? 0) + 1,
      }
      states.set(address(scope, key), state)
      return state
    },
    remove: async (scope, key, expectedRevision) => {
      const current = states.get(address(scope, key))
      if (expectedRevision !== undefined && expectedRevision !== current?.revision) throw new StorageHttpError(409)
      return states.delete(address(scope, key))
    },
    guardedBatch: async () => 0,
    replace: async () => 0,
    clear: async () => 0,
    migrationReceipt: async (name) => receipts.get(name),
    importLegacy: async (input) => {
      const current = receipts.get(input.name)
      if (current) return { applied: false, receipt: current }
      imports.push(input.name)
      const inserted = input.entries.filter((entry) => !states.has(address(entry.scope, entry.key)))
      for (const entry of inserted) await api.set(entry.scope, entry.key, entry.value)
      const receipt = {
        name: input.name,
        sourceFingerprint: input.sourceFingerprint,
        sourceVersion: input.sourceVersion,
        rowCount: inserted.length,
        timeCompleted: 1,
        timeVerified: 1,
      }
      receipts.set(input.name, receipt)
      return { applied: true, receipt }
    },
  }
  return { api, imports, receipts, states }
}
