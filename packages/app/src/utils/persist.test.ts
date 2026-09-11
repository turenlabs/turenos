import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Platform } from "@/context/platform"
import { ServerScope } from "./server-scope"

type PersistTestingType = typeof import("./persist").PersistTesting
type PersistType = typeof import("./persist").Persist
type RemovePersistedType = typeof import("./persist").removePersisted
type WritePersistedType = typeof import("./persist").writePersisted

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  maxBytes = Infinity
  failReads = false
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    if (this.failReads) throw new Error("storage unavailable")
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("opencode.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("opencode.throw")) throw new Error("storage set failed")
    const bytes = [...this.values].reduce(
      (total, [storedKey, storedValue]) => total + (storedKey === key ? 0 : storedKey.length + storedValue.length),
      0,
    )
    if (bytes + key.length + value.length > this.maxBytes) throw new DOMException("quota", "QuotaExceededError")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

let persistTesting: PersistTestingType
let Persist: PersistType
let removePersisted: RemovePersistedType
let writePersisted: WritePersistedType

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persistTesting = mod.PersistTesting
  Persist = mod.Persist
  removePersisted = mod.removePersisted
  writePersisted = mod.writePersisted
})

beforeEach(() => {
  storage.clear()
  storage.maxBytes = Infinity
  storage.failReads = false
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("verified writes reject fallback cache evidence when backing storage cannot be read", async () => {
    const target = Persist.draft("verified-quota", "prompt")
    expect(await writePersisted(target, undefined, { text: "saved" })).toBe(true)
    storage.failReads = true
    expect(await writePersisted(target, undefined, { text: "saved" })).toBe(false)
    storage.failReads = false
    removePersisted(target)
  })

  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("opencode.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("opencode.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
    storageApi.removeItem("value")
  })

  test("quota preserves prior drafts and recovery metadata while evicting only rebuildable caches", () => {
    const draft = persistTesting.localStorageWithPrefix("forge.draft.quota-test.dat")
    const other = persistTesting.localStorageWithPrefix("forge.draft.other-test.dat")
    const window = persistTesting.localStorageWithPrefix("forge.window.quota-test.dat")
    const cache = persistTesting.localStorageWithPrefix("forge.global.dat")
    draft.setItem("draft:prompt", "saved prompt")
    draft.setItem("draft:file-view", "saved draft view")
    other.setItem("draft:prompt", "other draft")
    window.setItem("tabs.closed", "saved recovery history")
    cache.setItem("command.catalog.v1", "cache".repeat(100))
    storage.maxBytes = 350
    draft.setItem("draft:prompt", "latest prompt")
    expect(draft.getItem("draft:prompt")).toBe("latest prompt")
    expect(draft.getItem("draft:file-view")).toBe("saved draft view")
    expect(other.getItem("draft:prompt")).toBe("other draft")
    expect(window.getItem("tabs.closed")).toBe("saved recovery history")
    expect(cache.getItem("command.catalog.v1")).toBeNull()
    expect(storage.events.filter((event) => event.startsWith("remove:"))).toEqual([
      "remove:forge.global.dat:command.catalog.v1",
    ])
  })

  test("failed replacement keeps its saved value and retries the latest edit after space is freed", () => {
    const draft = persistTesting.localStorageWithPrefix("forge.draft.retry-quota.dat")
    draft.setItem("draft:prompt", "saved")
    storage.maxBytes = 1
    draft.setItem("draft:prompt", "first unsaved edit")
    draft.setItem("draft:prompt", "latest unsaved edit")
    expect(storage.getItem("forge.draft.retry-quota.dat:draft:prompt")).toBe("saved")
    expect(storage.events.some((event) => event.startsWith("remove:"))).toBe(false)
    storage.maxBytes = Infinity
    persistTesting.retryFailedWrites()
    expect(draft.getItem("draft:prompt")).toBe("latest unsaved edit")
    draft.setItem("draft:prompt", "next edit")
    expect(draft.getItem("draft:prompt")).toBe("next edit")
  })

  test("successful edits and explicit removals supersede failed-save retries", () => {
    const draft = persistTesting.localStorageWithPrefix("forge.draft.stale-quota.dat")
    draft.setItem("draft:prompt", "saved")
    storage.maxBytes = 1
    draft.setItem("draft:prompt", "failed old edit")
    storage.maxBytes = Infinity
    draft.setItem("draft:prompt", "new saved edit")
    persistTesting.retryFailedWrites()
    expect(draft.getItem("draft:prompt")).toBe("new saved edit")
    storage.maxBytes = 1
    draft.setItem("draft:prompt", "another failed edit")
    draft.removeItem("draft:prompt")
    storage.maxBytes = Infinity
    persistTesting.retryFailedWrites()
    expect(draft.getItem("draft:prompt")).toBeNull()
  })

  test("quota during migration keeps the original saved prompt", () => {
    const legacy = persistTesting.localStorageDirect()
    const current = persistTesting.localStorageWithPrefix("forge.draft.migration-quota.dat")
    legacy.setItem("old-prompt", '{"text":"saved prompt"}')
    storage.maxBytes = 1
    expect(
      persistTesting.migrateLegacy({
        current,
        legacyStore: legacy,
        stores: [],
        keys: ["old-prompt"],
        key: "draft:prompt",
        defaults: { text: "" },
      }),
    ).toBe('{"text":"saved prompt"}')
    expect(legacy.getItem("old-prompt")).toBe('{"text":"saved prompt"}')
    expect(current.getItem("draft:prompt")).toBeNull()
    storage.maxBytes = Infinity
    persistTesting.retryFailedWrites()
    expect(current.getItem("draft:prompt")).toBe('{"text":"saved prompt"}')
  })

  test("failed asynchronous migration does not delete its source", async () => {
    const removed: string[] = []
    const current = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("disk full")
      },
      removeItem: async () => undefined,
    }
    const legacy = {
      getItem: async () => '{"text":"saved prompt"}',
      setItem: async () => undefined,
      removeItem: async (key: string) => {
        removed.push(key)
      },
    }
    expect(
      await persistTesting.migrateLegacyAsync({
        current,
        legacyStore: legacy,
        stores: [],
        keys: ["old-prompt"],
        key: "draft:prompt",
        defaults: { text: "" },
      }),
    ).toBe('{"text":"saved prompt"}')
    expect(removed).toEqual([])
  })

  test("sanitizes asynchronous migration values before the desktop write", async () => {
    let written: string | undefined
    const current = {
      getItem: async () => written ?? null,
      setItem: async (_key: string, value: string) => {
        written = value
      },
      removeItem: async () => undefined,
    }
    const legacy = {
      getItem: async () => '{"value":"legacy"}',
      setItem: async () => undefined,
      removeItem: async () => undefined,
    }

    expect(
      await persistTesting.migrateLegacyAsync({
        current,
        legacyStore: legacy,
        stores: [],
        keys: ["old-value"],
        key: "value",
        defaults: { value: "default" },
        sanitize: () => ({ value: "sanitized" }),
      }),
    ).toBe('{"value":"sanitized"}')
    expect(written).toBe('{"value":"sanitized"}')
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("opencode.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("opencode.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("opencode.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("opencode.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })

  test("normalizer sanitizes values before migration writes them back", () => {
    const result = persistTesting.normalize(
      { value: "default" },
      '{"value":"legacy"}',
      undefined,
      () => ({ value: "sanitized" }),
    )
    expect(result).toBe('{"value":"sanitized"}')
  })

  test("workspace storage sanitizes Windows filename characters", () => {
    const result = persistTesting.workspaceStorage("C:\\Users\\foo")

    expect(result).toStartWith("forge.workspace.")
    expect(result.endsWith(".dat")).toBeTrue()
    expect(/[:\\/]/.test(result)).toBeFalse()
  })

  test("workspace target keeps raw path storage as legacy fallback", () => {
    const target = Persist.workspace("C:\\Users\\foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/foo"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("workspace target keeps backslash storage as fallback for normalized Windows paths", () => {
    const target = Persist.workspace("C:/Users/foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/foo"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("migrates direct legacy keys into scoped storage", () => {
    storage.setItem("legacy.workspace", '{"value":2}')
    const target = Persist.workspace("C:/Users/foo", "demo", ["legacy.workspace"])
    const current = persistTesting.localStorageWithPrefix(target.storage!)
    const legacyStore = persistTesting.localStorageDirect()

    const result = persistTesting.migrateLegacy({
      current,
      legacyStore,
      stores: [],
      keys: target.legacy!,
      key: target.key,
      defaults: { value: 1 },
    })

    expect(result).toBe('{"value":2}')
    expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"value":2}')
    expect(legacyStore.getItem("legacy.workspace")).toBeNull()
    expect(storage.getItem("legacy.workspace")).toBeNull()
  })

  test("removes legacy workspace storage when removing persisted target", () => {
    const target = Persist.workspace("C:\\Users\\foo", "terminal")
    storage.setItem(`${target.storage}:${target.key}`, '{"value":1}')
    storage.setItem(`${target.legacyStorageNames![0]}:${target.key}`, '{"value":2}')

    removePersisted(target)

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBeNull()
    expect(storage.getItem(`${target.legacyStorageNames![0]}:${target.key}`)).toBeNull()
  })

  test("draft target isolates storage per draft and namespaces keys", () => {
    const a = Persist.draft("draft-a", "prompt")
    const b = Persist.draft("draft-b", "prompt")

    expect(a.key).toBe("draft:prompt")
    expect(a.storage).not.toBe(b.storage)
    expect(a.storage).not.toBe(Persist.workspace("/home/luke/repo", "prompt").storage)
  })

  test("removes draft storage when removing persisted target", () => {
    const target = Persist.draft("draft-a", "prompt")
    storage.setItem(`${target.storage}:${target.key}`, '{"value":1}')

    removePersisted(target)

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBeNull()
  })

  test("server workspace target preserves local storage and isolates remote storage", () => {
    const local = Persist.serverWorkspace(ServerScope.local, "/home/luke/repo", "prompt")
    const windows = Persist.serverWorkspace("https://windows.example" as ServerScope, "/home/luke/repo", "prompt")
    const debian = Persist.serverWorkspace("https://debian.example" as ServerScope, "/home/luke/repo", "prompt")

    expect(local).toEqual(Persist.workspace("/home/luke/repo", "prompt"))
    expect(windows.storage).not.toBe(local.storage)
    expect(debian.storage).not.toBe(local.storage)
    expect(debian.storage).not.toBe(windows.storage)
    expect(windows.legacyStorageNames).toBeUndefined()
    expect(debian.legacyStorageNames).toBeUndefined()
  })

  test("server global target preserves local key and isolates remote keys", () => {
    expect(Persist.serverGlobal(ServerScope.local, "notification")).toEqual(Persist.global("notification"))
    expect(Persist.serverGlobal("https://debian.example" as ServerScope, "notification")).toEqual({
      storage: "forge.global.dat",
      key: "https://debian.example\0notification",
    })
  })

  test("server global target cannot collide when scope and key contain colons", () => {
    expect(Persist.serverGlobal("a:b" as ServerScope, "c")).not.toEqual(Persist.serverGlobal("a" as ServerScope, "b:c"))
  })

  test("writes and awaits a durable scoped value", async () => {
    const target = Persist.global("lobby-agents")
    await writePersisted(target, undefined, { rooms: { room_1: { status: "ready" } } })

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"rooms":{"room_1":{"status":"ready"}}}')
  })

  test("sanitizes values before writing them to durable storage", async () => {
    const target = {
      ...Persist.global("prompt"),
      sanitize: (value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value
        const prompt = (value as { prompt?: unknown }).prompt
        if (!Array.isArray(prompt)) return value
        return { ...value, prompt: prompt.filter((part) => (part as { type?: string }).type !== "image") }
      },
    }

    await writePersisted(target, undefined, {
      prompt: [
        { type: "text", content: "look", start: 0, end: 4 },
        { type: "image", dataUrl: `data:image/png;base64,${"A".repeat(1024)}` },
      ],
    })

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBe(
      '{"prompt":[{"type":"text","content":"look","start":0,"end":4}]}',
    )
  })

  test("rejects when the storage backend cannot retain the value", async () => {
    const target = Persist.global("lobby-agents")
    const platform = {
      platform: "desktop" as const,
      openDirectoryPickerDialog: async () => null,
      openLink() {},
      restart: async () => {},
      back() {},
      forward() {},
      notify: async () => {},
      storage: () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
    } satisfies Platform

    await expect(writePersisted(target, platform, { rooms: {} })).resolves.toBe(false)
  })
})
