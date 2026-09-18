import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SshServerConfig, WslServerConfig } from "../../preload/types"
import { UPDATER_MAX_LAG, type UpdaterReadyRecord } from "../updater-controller"
import {
  DEFAULT_SERVER_URL_KEY,
  FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY,
  OLD_LAYOUT_ELIGIBLE_KEY,
  PINCH_ZOOM_ENABLED_KEY,
  WINDOW_IDS_KEY,
  WSL_SERVERS_KEY,
} from "../store-keys"
import type { StorageRemote } from "./client"

const SCOPE = "desktop/store/product-state-v1"
const SETTINGS_MIGRATION = "desktop.legacy.product-settings.v1"
const UPDATER_MIGRATION = "desktop.legacy.updater-ready.v1"
const SOURCE_VERSION = "desktop-product-state-v1"

const KEY = {
  defaultServerUrl: "default-server-url",
  firstLaunchOnboardingComplete: "first-launch-onboarding-complete",
  oldLayoutEligible: "old-layout-eligible",
  wslServers: "wsl-servers",
  sshServers: "ssh-servers",
  pinchZoomEnabled: "pinch-zoom-enabled",
  windowIds: "window-ids",
  updaterReady: "updater-ready",
  updaterLag: "updater-lag",
} as const

export type WindowGeometry = {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  fullScreen: boolean
}

type LegacyStore = { store: Record<string, unknown> }

type Options = {
  remote: StorageRemote
  userDataPath: string
  legacy: (name: string) => LegacyStore
  oldLayoutEligible: () => boolean
  warn?: (message: string, error: unknown) => void
}

type Owner = number | string

export type DesktopProductStorage = ReturnType<typeof createDesktopProductStorage>

export function createDesktopProductStorage(options: Options) {
  const revisions = new Map<Owner, Map<string, number | null>>()
  const imports = new Map<string, Promise<void>>()
  const mutations = new Map<string, Promise<void>>()
  const pending = new Set<Promise<unknown>>()
  const failures = new Map<string, Error>()
  let sealed = false

  const ownerRevisions = (owner: Owner) => {
    const current = revisions.get(owner)
    if (current) return current
    const created = new Map<string, number | null>()
    revisions.set(owner, created)
    return created
  }

  const getRaw = async (owner: Owner, key: string) => {
    const current = await options.remote.get(SCOPE, key)
    ownerRevisions(owner).set(key, current?.revision ?? null)
    return current?.value
  }

  const expectedRevision = async (owner: Owner, key: string) => {
    const known = ownerRevisions(owner)
    if (known.has(key)) return known.get(key) ?? null
    await getRaw(owner, key)
    return known.get(key) ?? null
  }

  const publishRevision = (key: string, revision: number | null) => {
    revisions.forEach((known) => {
      if (known.has(key)) known.set(key, revision)
    })
  }

  const setRaw = async (owner: Owner, key: string, value: string) => {
    await mutate(key, async () => {
      const written = await options.remote.set(SCOPE, key, value, await expectedRevision(owner, key))
      ownerRevisions(owner).set(key, written.revision)
      publishRevision(key, written.revision)
    })
  }

  const removeRaw = async (owner: Owner, key: string) => {
    await mutate(key, async () => {
      const expected = await expectedRevision(owner, key)
      if (expected === null) return
      await options.remote.remove(SCOPE, key, expected)
      ownerRevisions(owner).set(key, null)
      publishRevision(key, null)
    })
  }

  const mutate = <T>(key: string, run: () => Promise<T>) => {
    if (sealed) return Promise.reject(new Error("Desktop product Storage is shutting down"))
    const result = (mutations.get(key) ?? Promise.resolve()).then(run, run)
    pending.add(result)
    void result.then(
      () => failures.delete(key),
      (error) => failures.set(key, error instanceof Error ? error : new Error("Desktop product Storage write failed")),
    )
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    )
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    mutations.set(key, settled)
    void settled.then(() => {
      if (mutations.get(key) === settled) mutations.delete(key)
    })
    return result
  }

  const ensureImport = (name: string, run: () => Promise<void>) => {
    const current = imports.get(name)
    if (current) return current
    const next = run().catch((error) => {
      imports.delete(name)
      throw error
    })
    imports.set(name, next)
    return next
  }

  const importEntries = async (name: string, sourceVersion: string, entries: Array<{ key: string; value: string }>) => {
    if (await options.remote.migrationReceipt(name)) return
    const sorted = entries.sort((a, b) => a.key.localeCompare(b.key))
    const fingerprint = createHash("sha256")
    sorted.forEach((entry) => {
      fingerprint.update(entry.key)
      fingerprint.update("\0")
      fingerprint.update(entry.value)
      fingerprint.update("\0")
    })
    await options.remote.importLegacy({
      name,
      sourceFingerprint: fingerprint.digest("hex"),
      sourceVersion,
      entries: sorted.map((entry) => ({ scope: SCOPE, ...entry })),
    })
  }

  const importSettings = () =>
    ensureImport(SETTINGS_MIGRATION, async () => {
      const source = options.legacy("forge.settings").store
      const entries = [
        encoded(KEY.defaultServerUrl, source[DEFAULT_SERVER_URL_KEY], isNullableString),
        encoded(KEY.firstLaunchOnboardingComplete, source[FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY], isBoolean),
        encoded(KEY.oldLayoutEligible, source[OLD_LAYOUT_ELIGIBLE_KEY], isBoolean),
        encoded(KEY.wslServers, normalizeWslServers(source[WSL_SERVERS_KEY]), isWslServers),
        encoded(KEY.pinchZoomEnabled, source[PINCH_ZOOM_ENABLED_KEY], isBoolean),
        encoded(KEY.windowIds, normalizeWindowIds(source[WINDOW_IDS_KEY]), isStringArray),
      ].filter((entry): entry is { key: string; value: string } => Boolean(entry))
      if (!entries.some((entry) => entry.key === KEY.oldLayoutEligible)) {
        entries.push({ key: KEY.oldLayoutEligible, value: JSON.stringify(options.oldLayoutEligible()) })
      }
      await importEntries(SETTINGS_MIGRATION, SOURCE_VERSION, entries)
    })

  const importUpdater = () =>
    ensureImport(UPDATER_MIGRATION, async () => {
      const source = options.legacy("forge.updater").store.ready
      await importEntries(
        UPDATER_MIGRATION,
        SOURCE_VERSION,
        encoded(KEY.updaterReady, source, isUpdaterReady)
          ? [{ key: KEY.updaterReady, value: JSON.stringify(source) }]
          : [],
      )
    })

  const importWindowStates = async () => {
    const files = (
      await readdir(options.userDataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
    )
      .filter((name) => /^window-state-.+\.json$/.test(name))
      .sort()
    await Promise.all(
      files.map(async (name) => {
        const migration = `desktop.legacy.window-state.v1.${hash(name)}`
        await ensureImport(migration, async () => {
          const raw = await readFile(join(options.userDataPath, name), "utf8")
          const geometry = normalizeWindowGeometry(JSON.parse(raw) as unknown)
          const id = name.slice("window-state-".length, -".json".length)
          await importEntries(
            migration,
            "electron-window-state-v5",
            geometry ? [{ key: windowGeometryKey(id), value: JSON.stringify(geometry) }] : [],
          )
        }).catch((error) => options.warn?.("failed to import legacy window state", error))
      }),
    )
  }

  const ready = Promise.all([importSettings(), importUpdater(), importWindowStates()]).then(() => undefined)
  const read = async <T>(owner: Owner, key: string, guard: (value: unknown) => value is T) => {
    await ready
    await mutations.get(key)
    const raw = await getRaw(owner, key)
    if (raw === undefined) return
    const parsed = parse(raw)
    if (parsed === undefined || !guard(parsed)) throw new Error(`Invalid Desktop product Storage value: ${key}`)
    return parsed
  }
  const write = async (owner: Owner, key: string, value: unknown) => {
    await ready
    await setRaw(owner, key, JSON.stringify(value))
  }

  return {
    ready: () => ready,
    release(owner: Owner) {
      revisions.delete(owner)
    },
    seal() {
      sealed = true
    },
    resume() {
      sealed = false
    },
    async drain() {
      await ready
      await Promise.allSettled(pending)
      while (mutations.size > 0) await Promise.all(mutations.values())
      const failure = failures.values().next().value
      if (failure) throw failure
    },
    getDefaultServerUrl: (owner: Owner) => read(owner, KEY.defaultServerUrl, isNullableString),
    setDefaultServerUrl: async (owner: Owner, value: string | null) => {
      if (value === null) {
        await ready
        return removeRaw(owner, KEY.defaultServerUrl)
      }
      await write(owner, KEY.defaultServerUrl, value)
    },
    isFirstLaunchOnboardingPending: async (owner: Owner) =>
      (await read(owner, KEY.firstLaunchOnboardingComplete, isBoolean)) !== true,
    finishFirstLaunchOnboarding: (owner: Owner) => write(owner, KEY.firstLaunchOnboardingComplete, true),
    isOldLayoutEligible: async (owner: Owner) => (await read(owner, KEY.oldLayoutEligible, isBoolean)) === true,
    getWslServers: async (owner: Owner) => (await read(owner, KEY.wslServers, isWslServers)) ?? [],
    setWslServers: (owner: Owner, value: WslServerConfig[]) => write(owner, KEY.wslServers, value),
    getSshServers: async (owner: Owner) => (await read(owner, KEY.sshServers, isSshServers)) ?? [],
    setSshServers: (owner: Owner, value: SshServerConfig[]) => write(owner, KEY.sshServers, value),
    getPinchZoomEnabled: async (owner: Owner) => (await read(owner, KEY.pinchZoomEnabled, isBoolean)) === true,
    setPinchZoomEnabled: (owner: Owner, value: boolean) => write(owner, KEY.pinchZoomEnabled, value),
    getWindowIds: async (owner: Owner) => (await read(owner, KEY.windowIds, isStringArray)) ?? [],
    setWindowIds: (owner: Owner, value: string[]) => write(owner, KEY.windowIds, value),
    getWindowGeometry: (owner: Owner, id: string) => read(owner, windowGeometryKey(id), isWindowGeometry),
    setWindowGeometry: (owner: Owner, id: string, value: WindowGeometry) => {
      const usable = clampWindowGeometry(value)
      if (!usable) return Promise.resolve()
      return write(owner, windowGeometryKey(id), usable)
    },
    async removeWindow(owner: Owner, id: string) {
      await ready
      await Promise.all([removeRaw(owner, windowGeometryKey(id)), removeRaw(owner, windowLastActiveUrlKey(id))])
    },
    getUpdaterReady: (owner: Owner) => read(owner, KEY.updaterReady, isUpdaterReady),
    setUpdaterReady: (owner: Owner, value: UpdaterReadyRecord) => write(owner, KEY.updaterReady, value),
    clearUpdaterReady: async (owner: Owner) => {
      await ready
      await removeRaw(owner, KEY.updaterReady)
    },
    getUpdaterLag: (owner: Owner) => read(owner, KEY.updaterLag, isUpdaterLag),
    setUpdaterLag: (owner: Owner, value: number) => write(owner, KEY.updaterLag, value),
    async getWindowLastActiveUrl(owner: Owner, id: string, legacy: { readable: boolean; value: string | null }) {
      await ready
      if (legacy.readable) {
        const migration = `desktop.legacy.renderer-last-active-url.v1.${hash(id)}`
        await ensureImport(migration, () =>
          importEntries(
            migration,
            "renderer-local-storage-v1",
            validRelativeUrl(legacy.value)
              ? [{ key: windowLastActiveUrlKey(id), value: JSON.stringify(legacy.value) }]
              : [],
          ),
        )
      }
      return (await read(owner, windowLastActiveUrlKey(id), isRelativeUrl)) ?? "/"
    },
    setWindowLastActiveUrl: (owner: Owner, id: string, value: string) => {
      if (!validRelativeUrl(value)) throw new Error("Invalid window URL")
      return write(owner, windowLastActiveUrlKey(id), value)
    },
  }
}

function encoded<T>(key: string, value: unknown, guard: (value: unknown) => value is T) {
  if (!guard(value)) return
  return { key, value: JSON.stringify(value) }
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function windowGeometryKey(id: string) {
  return `window/${hash(id)}/geometry`
}

function windowLastActiveUrlKey(id: string) {
  return `window/${hash(id)}/last-active-url`
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
}

function normalizeWindowIds(value: unknown) {
  if (!Array.isArray(value)) return
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function isWslServers(value: unknown): value is WslServerConfig[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof item.id === "string" &&
        "distro" in item &&
        typeof item.distro === "string",
    )
  )
}

function normalizeWslServers(value: unknown) {
  if (!value || typeof value !== "object" || !("servers" in value) || !Array.isArray(value.servers)) return
  const servers = value.servers.flatMap((item): WslServerConfig[] => {
    if (!item || typeof item !== "object") return []
    const distro = "distro" in item && typeof item.distro === "string" && item.distro.length > 0 ? item.distro : null
    if (!distro) return []
    const id = "id" in item && typeof item.id === "string" && item.id.length > 0 ? item.id : `wsl:${distro}`
    return [{ id, distro }]
  })
  return servers
}

function isSshServers(value: unknown): value is SshServerConfig[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof item.id === "string" &&
        item.id.startsWith("ssh:") &&
        "host" in item &&
        typeof item.host === "string" &&
        item.host.length > 0,
    )
  )
}

function isUpdaterReady(value: unknown): value is UpdaterReadyRecord {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string"
}

function isUpdaterLag(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= UPDATER_MAX_LAG
}

function normalizeWindowGeometry(value: unknown): WindowGeometry | undefined {
  if (!value || typeof value !== "object") return
  if (!("width" in value) || typeof value.width !== "number" || value.width <= 0) return
  if (!("height" in value) || typeof value.height !== "number" || value.height <= 0) return
  return {
    ...("x" in value && typeof value.x === "number" ? { x: value.x } : {}),
    ...("y" in value && typeof value.y === "number" ? { y: value.y } : {}),
    width: value.width,
    height: value.height,
    maximized: "isMaximized" in value ? value.isMaximized === true : false,
    fullScreen: "isFullScreen" in value ? value.isFullScreen === true : false,
  }
}

/**
 * Smallest geometry worth restoring. A window persisted below this is unusable
 * and reads to the user as a failed launch: a real 1x32 row survived a
 * SIGKILL mid-teardown and reopened as an invisible sliver, because the only
 * check here was `> 0`. Rejecting on read makes a bad row self-healing — the
 * caller falls back to its default size — and `clampWindowGeometry` stops one
 * being written in the first place.
 */
export const MIN_WINDOW_WIDTH = 400
export const MIN_WINDOW_HEIGHT = 300

/** Refuses to persist a collapsed window; returns undefined when unusable. */
export function clampWindowGeometry(value: WindowGeometry): WindowGeometry | undefined {
  if (value.maximized || value.fullScreen) return value
  if (value.width < MIN_WINDOW_WIDTH || value.height < MIN_WINDOW_HEIGHT) return undefined
  return value
}

function isWindowGeometry(value: unknown): value is WindowGeometry {
  if (!value || typeof value !== "object") return false
  const maximized = "maximized" in value && value.maximized === true
  const fullScreen = "fullScreen" in value && value.fullScreen === true
  const floored = maximized || fullScreen
  return (
    "width" in value &&
    typeof value.width === "number" &&
    (floored ? value.width > 0 : value.width >= MIN_WINDOW_WIDTH) &&
    "height" in value &&
    typeof value.height === "number" &&
    (floored ? value.height > 0 : value.height >= MIN_WINDOW_HEIGHT) &&
    "maximized" in value &&
    typeof value.maximized === "boolean" &&
    "fullScreen" in value &&
    typeof value.fullScreen === "boolean"
  )
}

function validRelativeUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
}

function isRelativeUrl(value: unknown): value is string {
  return validRelativeUrl(value)
}
