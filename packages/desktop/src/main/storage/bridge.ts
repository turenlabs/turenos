import { createHash } from "node:crypto"
import type { StorageRemote } from "./client"

type LegacyStore = {
  store: Record<string, unknown>
}

type Options = {
  remote: StorageRemote
  legacy: (name: string) => LegacyStore
}

export type DesktopStorage = {
  get(owner: number | string, name: string, key: string): Promise<string | null>
  set(owner: number | string, name: string, key: string, value: string): Promise<void>
  remove(owner: number | string, name: string, key: string): Promise<void>
  clear(owner: number | string, name: string): Promise<void>
  keys(owner: number | string, name: string): Promise<string[]>
  length(owner: number | string, name: string): Promise<number>
  release(owner: number | string): void
  seal(): void
  resume(): void
  drain(): Promise<void>
}

export function createDesktopStorage(options: Options): DesktopStorage {
  const imports = new Map<string, Promise<void>>()
  const revisions = new Map<number | string, Map<string, number | null>>()
  const mutations = new Map<string, Promise<void>>()
  const scopeMutations = new Map<string, Promise<void>>()
  const pending = new Set<Promise<unknown>>()
  const failures = new Map<string, Error>()
  let sealed = false

  const ensureImported = (name: string) => {
    const current = imports.get(name)
    if (current) return current
    if (sealed) return Promise.reject(new Error("Desktop Storage is shutting down"))
    const next = importLegacyStore(options, name).catch((error) => {
      imports.delete(name)
      throw error
    })
    imports.set(name, next)
    return next
  }

  const ownerRevisions = (owner: number | string) => {
    const current = revisions.get(owner)
    if (current) return current
    const created = new Map<string, number | null>()
    revisions.set(owner, created)
    return created
  }

  const address = (name: string, key: string) => `${desktopStorageScope(name)}\0${key}`

  const mutate = <T>(name: string, key: string, run: () => Promise<T>) => {
    const target = address(name, key)
    if (sealed) return Promise.reject(new Error("Desktop Storage is shutting down"))
    const scope = desktopStorageScope(name)
    const result = Promise.all([mutations.get(target), scopeMutations.get(scope)]).then(run)
    track(target, result)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    mutations.set(target, settled)
    void settled.then(() => {
      if (mutations.get(target) === settled) mutations.delete(target)
    })
    return result
  }

  const mutateScope = <T>(name: string, run: () => Promise<T>) => {
    const scope = desktopStorageScope(name)
    if (sealed) return Promise.reject(new Error("Desktop Storage is shutting down"))
    const result = Promise.all(pendingScope(name)).then(run)
    track(`${scope}\0`, result)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    scopeMutations.set(scope, settled)
    void settled.then(() => {
      if (scopeMutations.get(scope) === settled) scopeMutations.delete(scope)
    })
    return result
  }

  const pendingScope = (name: string) => {
    const scope = desktopStorageScope(name)
    const prefix = `${scope}\0`
    return [
      scopeMutations.get(scope),
      ...[...mutations].flatMap(([key, pending]) => (key.startsWith(prefix) ? [pending] : [])),
    ]
  }

  const track = <T>(target: string, result: Promise<T>) => {
    pending.add(result)
    void result.then(
      () => failures.delete(target),
      (error) => failures.set(target, error instanceof Error ? error : new Error("Desktop Storage write failed")),
    )
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    )
  }

  const publishRevision = (target: string, value: number | null) => {
    revisions.forEach((known) => {
      if (known.has(target)) known.set(target, value)
    })
  }

  const revision = async (owner: number | string, name: string, key: string) => {
    const known = ownerRevisions(owner)
    const target = address(name, key)
    if (known.has(target)) return known.get(target) ?? null
    const current = await options.remote.get(desktopStorageScope(name), key)
    known.set(target, current?.revision ?? null)
    return current?.revision ?? null
  }

  return {
    async get(owner, name, key) {
      await ensureImported(name)
      await Promise.all([mutations.get(address(name, key)), scopeMutations.get(desktopStorageScope(name))])
      const current = await options.remote.get(desktopStorageScope(name), key)
      ownerRevisions(owner).set(address(name, key), current?.revision ?? null)
      return current?.value ?? null
    },
    async set(owner, name, key, value) {
      await ensureImported(name)
      await mutate(name, key, async () => {
        const written = await options.remote.set(
          desktopStorageScope(name),
          key,
          value,
          await revision(owner, name, key),
        )
        const target = address(name, key)
        ownerRevisions(owner).set(target, written.revision)
        publishRevision(target, written.revision)
      })
    },
    async remove(owner, name, key) {
      await ensureImported(name)
      await mutate(name, key, async () => {
        const expectedRevision = await revision(owner, name, key)
        if (expectedRevision === null) return
        await options.remote.remove(desktopStorageScope(name), key, expectedRevision)
        const target = address(name, key)
        ownerRevisions(owner).set(target, null)
        publishRevision(target, null)
      })
    },
    async clear(_owner, name) {
      await ensureImported(name)
      const prefix = `${desktopStorageScope(name)}\0`
      await mutateScope(name, async () => {
        await options.remote.clear(desktopStorageScope(name))
        revisions.forEach((known) => {
          for (const key of known.keys()) {
            if (key.startsWith(prefix)) known.delete(key)
          }
        })
        for (const key of failures.keys()) {
          if (key.startsWith(prefix)) failures.delete(key)
        }
      })
    },
    async keys(owner, name) {
      await ensureImported(name)
      await Promise.all(pendingScope(name))
      const items = await options.remote.list(desktopStorageScope(name))
      items.forEach((item) => ownerRevisions(owner).set(address(name, item.key), item.revision))
      return items.map((item) => item.key)
    },
    async length(owner, name) {
      await ensureImported(name)
      await Promise.all(pendingScope(name))
      const items = await options.remote.list(desktopStorageScope(name))
      items.forEach((item) => ownerRevisions(owner).set(address(name, item.key), item.revision))
      return items.length
    },
    release(owner) {
      revisions.delete(owner)
    },
    seal() {
      sealed = true
    },
    resume() {
      sealed = false
    },
    async drain() {
      await Promise.all(imports.values())
      await Promise.allSettled(pending)
      while (mutations.size > 0 || scopeMutations.size > 0) {
        await Promise.all([...mutations.values(), ...scopeMutations.values()])
      }
      const failure = failures.values().next().value
      if (failure) throw failure
    },
  }
}

async function importLegacyStore(options: Options, name: string) {
  const receipt = desktopStorageMigrationName(name)
  if (await options.remote.migrationReceipt(receipt)) return

  const entries = Object.entries(options.legacy(name).store)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null) return []
      return [
        { scope: desktopStorageScope(name), key, value: typeof value === "string" ? value : JSON.stringify(value) },
      ]
    })
    .sort((a, b) => a.key.localeCompare(b.key))
  const fingerprint = createHash("sha256")
  for (const entry of entries) {
    fingerprint.update(entry.scope)
    fingerprint.update("\0")
    fingerprint.update(entry.key)
    fingerprint.update("\0")
    fingerprint.update(entry.value)
    fingerprint.update("\0")
  }
  await options.remote.importLegacy({
    name: receipt,
    sourceFingerprint: fingerprint.digest("hex"),
    sourceVersion: "electron-store-v1",
    entries,
  })
}

export function desktopStorageScope(name: string) {
  return `desktop/store/${name.slice(0, 200)}.${createHash("sha256").update(name).digest("hex").slice(0, 16)}`
}

export function desktopStorageMigrationName(name: string) {
  return `desktop.electron-store.${name.slice(0, 160)}.${createHash("sha256").update(name).digest("hex").slice(0, 16)}`
}
