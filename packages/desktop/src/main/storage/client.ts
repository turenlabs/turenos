import type { ServerReadyData } from "../../preload/types"

export type StorageState = {
  scope: string
  key: string
  value: string
  revision: number
  timeCreated: number
  timeUpdated: number
}

export type StorageMigrationReceipt = {
  name: string
  sourceFingerprint: string | null
  sourceVersion: string | null
  rowCount: number | null
  timeCompleted: number
  timeVerified: number | null
}

export type StorageImportEntry = {
  scope: string
  key: string
  value: string
}

export type StorageReplaceEntry = {
  key: string
  value: string
}

export type StorageGuardedBatch = {
  guards: Array<{ scope: string; key: string; expectedRevision: number | null }>
  sets: Array<{ scope: string; key: string; value: string }>
  removes: Array<{ scope: string; key: string }>
}

export type StorageRemote = {
  get(scope: string, key: string): Promise<StorageState | undefined>
  list(scope: string): Promise<StorageState[]>
  set(scope: string, key: string, value: string, expectedRevision?: number | null): Promise<StorageState>
  remove(scope: string, key: string, expectedRevision?: number): Promise<boolean>
  guardedBatch(input: StorageGuardedBatch): Promise<number>
  replace(scope: string, entries: StorageReplaceEntry[]): Promise<number>
  clear(scope: string): Promise<number>
  migrationReceipt(name: string): Promise<StorageMigrationReceipt | undefined>
  importLegacy(input: {
    name: string
    sourceFingerprint: string
    sourceVersion: string
    entries: StorageImportEntry[]
  }): Promise<{ applied: boolean; receipt: StorageMigrationReceipt }>
}

type Options = {
  ready: () => Promise<ServerReadyData>
  fetch?: typeof fetch
  retryDelay?: (attempt: number) => Promise<void>
  attempts?: number
}

export class StorageHttpError extends Error {
  constructor(readonly status: number) {
    super(`Storage request failed with status ${status}`)
  }
}

export function createStorageRemote(options: Options): StorageRemote {
  const request = async (path: string, init?: RequestInit) => {
    const ready = await options.ready()
    const url = new URL(path, ready.url)
    const authorization =
      ready.username && ready.password
        ? `Basic ${Buffer.from(`${ready.username}:${ready.password}`).toString("base64")}`
        : undefined
    const headers = new Headers(init?.headers)
    if (authorization) headers.set("authorization", authorization)
    if (init?.body) headers.set("content-type", "application/json")

    const attempts = options.attempts ?? 60
    const run = options.fetch ?? fetch
    for (const attempt of Array.from({ length: attempts }, (_, index) => index)) {
      const response = await run(url, { ...init, headers }).catch((error) => {
        if (attempt === attempts - 1) throw error
        return undefined
      })
      if (response && ![429, 502, 503, 504].includes(response.status)) {
        if (!response.ok) throw new StorageHttpError(response.status)
        return response
      }
      if (attempt === attempts - 1) throw new StorageHttpError(response?.status ?? 503)
      await (options.retryDelay?.(attempt) ??
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(50 * (attempt + 1), 500))))
    }
    throw new StorageHttpError(503)
  }

  const query = (path: string, values: Record<string, string>) => {
    const params = new URLSearchParams(values)
    return `${path}?${params.toString()}`
  }

  return {
    async get(scope, key) {
      const body = (await request(query("/global/storage", { scope, key })).then((response) => response.json())) as {
        state: StorageState | null
      }
      return body.state ?? undefined
    },
    async list(scope) {
      const body = (await request(query("/global/storage/list", { scope })).then((response) => response.json())) as {
        items: StorageState[]
      }
      return body.items
    },
    async set(scope, key, value, expectedRevision) {
      return (await request("/global/storage", {
        method: "PUT",
        body: JSON.stringify(
          expectedRevision === undefined ? { scope, key, value } : { scope, key, value, expectedRevision },
        ),
      }).then((response) => response.json())) as StorageState
    },
    async remove(scope, key, expectedRevision) {
      const body = (await request(
        query("/global/storage", {
          scope,
          key,
          ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision.toString() }),
        }),
        { method: "DELETE" },
      ).then((response) => response.json())) as { removed: boolean }
      return body.removed
    },
    async guardedBatch(input) {
      const body = (await request("/global/storage/batch", {
        method: "POST",
        body: JSON.stringify(input),
      }).then((response) => response.json())) as { written: number }
      return body.written
    },
    async replace(scope, entries) {
      const body = (await request("/global/storage/scope", {
        method: "PUT",
        body: JSON.stringify({ scope, entries }),
      }).then((response) => response.json())) as { written: number }
      return body.written
    },
    async clear(scope) {
      const body = (await request(query("/global/storage/scope", { scope }), { method: "DELETE" }).then((response) =>
        response.json(),
      )) as { removed: number }
      return body.removed
    },
    async migrationReceipt(name) {
      const body = (await request(query("/global/storage/import/receipt", { name })).then((response) =>
        response.json(),
      )) as { receipt: StorageMigrationReceipt | null }
      return body.receipt ?? undefined
    },
    async importLegacy(input) {
      return (await request("/global/storage/import", {
        method: "POST",
        body: JSON.stringify(input),
      }).then((response) => response.json())) as { applied: boolean; receipt: StorageMigrationReceipt }
    },
  }
}
