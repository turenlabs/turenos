import { describe, expect, test } from "bun:test"
import { createDesktopStorage } from "./bridge"
import { StorageHttpError } from "./client"
import type { StorageMigrationReceipt, StorageRemote, StorageState } from "./client"

function remote() {
  const states = new Map<string, StorageState>()
  const receipts = new Map<string, StorageMigrationReceipt>()
  const imports: Array<{ name: string; entries: Array<{ scope: string; key: string; value: string }> }> = []
  const key = (scope: string, name: string) => `${scope}\0${name}`
  const api: StorageRemote = {
    get: async (scope, name) => states.get(key(scope, name)),
    list: async (scope) =>
      [...states.values()].filter((item) => item.scope === scope).sort((a, b) => a.key.localeCompare(b.key)),
    set: async (scope, name, value, expectedRevision) => {
      const current = states.get(key(scope, name))
      if (expectedRevision !== undefined && expectedRevision !== (current?.revision ?? null)) {
        throw new StorageHttpError(409)
      }
      const state = {
        scope,
        key: name,
        value,
        revision: (current?.revision ?? 0) + 1,
        timeCreated: current?.timeCreated ?? 1,
        timeUpdated: (current?.timeUpdated ?? 0) + 1,
      }
      states.set(key(scope, name), state)
      return state
    },
    remove: async (scope, name, expectedRevision) => {
      const current = states.get(key(scope, name))
      if (expectedRevision !== undefined && expectedRevision !== current?.revision) throw new StorageHttpError(409)
      return states.delete(key(scope, name))
    },
    guardedBatch: async () => 0,
    replace: async (scope, entries) => {
      const matches = [...states.values()].filter((item) => item.scope === scope)
      matches.forEach((item) => states.delete(key(item.scope, item.key)))
      for (const entry of entries) await api.set(scope, entry.key, entry.value)
      return entries.length
    },
    clear: async (scope) => {
      const matches = [...states.values()].filter((item) => item.scope === scope)
      matches.forEach((item) => states.delete(key(item.scope, item.key)))
      return matches.length
    },
    migrationReceipt: async (name) => receipts.get(name),
    importLegacy: async (input) => {
      imports.push({ name: input.name, entries: input.entries })
      const current = receipts.get(input.name)
      if (current) return { applied: false, receipt: current }
      for (const entry of input.entries) {
        if (states.has(key(entry.scope, entry.key))) continue
        await api.set(entry.scope, entry.key, entry.value)
      }
      const receipt = {
        name: input.name,
        sourceFingerprint: input.sourceFingerprint,
        sourceVersion: input.sourceVersion,
        rowCount: input.entries.length,
        timeCompleted: 1,
        timeVerified: 1,
      }
      receipts.set(input.name, receipt)
      return { applied: true, receipt }
    },
  }
  return { api, imports, receipts, states }
}

describe("desktop Storage bridge", () => {
  test("imports a legacy Electron store once and serves all operations from Storage", async () => {
    const state = remote()
    const legacy = { alpha: "one", object: { enabled: true }, ignored: null }
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: legacy }) })

    expect(await storage.get(1, "forge.global.dat", "alpha")).toBe("one")
    expect(await storage.get(1, "forge.global.dat", "object")).toBe('{"enabled":true}')
    expect(await storage.keys(1, "forge.global.dat")).toEqual(["alpha", "object"])
    expect(await storage.length(1, "forge.global.dat")).toBe(2)
    expect(state.imports).toHaveLength(1)

    await storage.set(1, "forge.global.dat", "alpha", "two")
    expect(await storage.get(1, "forge.global.dat", "alpha")).toBe("two")
    await storage.remove(1, "forge.global.dat", "object")
    expect(await storage.keys(1, "forge.global.dat")).toEqual(["alpha"])
    await storage.clear(1, "forge.global.dat")
    expect(await storage.length(1, "forge.global.dat")).toBe(0)
  })

  test("treats a committed receipt as authority and never reimports a retained legacy file", async () => {
    const state = remote()
    const first = createDesktopStorage({ remote: state.api, legacy: () => ({ store: { theme: "old" } }) })
    expect(await first.get(1, "forge.global.dat", "theme")).toBe("old")
    await first.set(1, "forge.global.dat", "theme", "new")

    const restarted = createDesktopStorage({ remote: state.api, legacy: () => ({ store: { theme: "stale" } }) })
    expect(await restarted.get(1, "forge.global.dat", "theme")).toBe("new")
    expect(state.imports).toHaveLength(1)
  })

  test("coalesces concurrent first access into one atomic import", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: { one: "1", two: "2" } }) })

    expect(await Promise.all([storage.get(1, "scope", "one"), storage.get(1, "scope", "two")])).toEqual(["1", "2"])
    expect(state.imports).toHaveLength(1)
  })

  test("propagates committed revisions across renderers without replaying stale requests", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: {} }) })

    await storage.set(1, "forge.global.dat", "theme", "initial")
    expect(await storage.get(1, "forge.global.dat", "theme")).toBe("initial")
    expect(await storage.get(2, "forge.global.dat", "theme")).toBe("initial")
    await storage.set(1, "forge.global.dat", "theme", "renderer-a")

    await storage.set(2, "forge.global.dat", "theme", "renderer-b")
    await storage.remove(1, "forge.global.dat", "theme")
    expect(await storage.get(2, "forge.global.dat", "theme")).toBeNull()
  })

  test("serializes concurrent writes from one renderer to the same key", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: {} }) })
    await storage.set(1, "forge.global.dat", "layout", "initial")

    const original = state.api.set
    const started = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    state.api.set = async (scope, key, value, expectedRevision) => {
      if (value === "first") {
        started.resolve()
        await blocked.promise
      }
      return original(scope, key, value, expectedRevision)
    }

    const first = storage.set(1, "forge.global.dat", "layout", "first")
    await started.promise
    const second = storage.set(1, "forge.global.dat", "layout", "second")
    blocked.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(await storage.get(1, "forge.global.dat", "layout")).toBe("second")
    expect([...state.states.values()].find((item) => item.key === "layout")?.revision).toBe(3)
  })

  test("serializes concurrent writes from two renderers and drains the committed tail", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: {} }) })
    await storage.set(1, "forge.global.dat", "layout", "initial")
    expect(await storage.get(2, "forge.global.dat", "layout")).toBe("initial")

    const original = state.api.set
    const started = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    state.api.set = async (scope, key, value, expectedRevision) => {
      if (value === "renderer-a") {
        started.resolve()
        await blocked.promise
      }
      return original(scope, key, value, expectedRevision)
    }

    const first = storage.set(1, "forge.global.dat", "layout", "renderer-a")
    await started.promise
    const second = storage.set(2, "forge.global.dat", "layout", "renderer-b")
    const drained = storage.drain()
    let complete = false
    void drained.then(() => (complete = true))
    await Promise.resolve()
    expect(complete).toBe(false)
    blocked.resolve()

    await expect(Promise.all([first, second, drained])).resolves.toEqual([undefined, undefined, undefined])
    expect(await storage.get(1, "forge.global.dat", "layout")).toBe("renderer-b")
    expect([...state.states.values()].find((item) => item.key === "layout")?.revision).toBe(3)
  })

  test("orders scope clears between earlier and later writes", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: {} }) })
    await storage.set(1, "forge.global.dat", "layout", "initial")

    const original = state.api.set
    const started = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    state.api.set = async (scope, key, value, expectedRevision) => {
      if (value === "before-clear") {
        started.resolve()
        await blocked.promise
      }
      return original(scope, key, value, expectedRevision)
    }

    const first = storage.set(1, "forge.global.dat", "layout", "before-clear")
    await started.promise
    const clear = storage.clear(1, "forge.global.dat")
    const second = storage.set(2, "forge.global.dat", "layout", "after-clear")
    blocked.resolve()

    await expect(Promise.all([first, clear, second])).resolves.toEqual([undefined, undefined, undefined])
    expect(await storage.get(1, "forge.global.dat", "layout")).toBe("after-clear")
  })

  test("releases renderer revision state when its web contents is destroyed", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: {} }) })
    await storage.set(1, "forge.global.dat", "theme", "initial")
    storage.release(1)
    await state.api.set([...state.states.values()][0].scope, "theme", "external")

    await storage.set(1, "forge.global.dat", "theme", "reopened")
    expect(await storage.get(1, "forge.global.dat", "theme")).toBe("reopened")
  })

  test("surfaces failed writes through the shutdown drain and rejects late admission", async () => {
    const state = remote()
    const storage = createDesktopStorage({ remote: state.api, legacy: () => ({ store: {} }) })
    state.api.set = async () => {
      throw new Error("disk unavailable")
    }

    await expect(storage.set(1, "forge.global.dat", "theme", "dark")).rejects.toThrow("disk unavailable")
    storage.seal()
    await expect(storage.drain()).rejects.toThrow("disk unavailable")
    await expect(storage.set(1, "forge.global.dat", "theme", "light")).rejects.toThrow("shutting down")
  })
})
