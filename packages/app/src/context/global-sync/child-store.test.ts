import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@turenlabs/session-ui/context"
import type { State } from "./types"
import type { QueryOptionsApi } from "../server-sync"
import { ServerScope } from "@/utils/server-scope"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
const querySingles: Array<() => { queryKey?: unknown[]; enabled?: boolean }> = []
const persist: typeof import("@/utils/persist").persisted = (_target, store) => [
  store[0],
  store[1],
  null,
  Object.assign(() => true, { promise: undefined }),
]

const child = () => createStore({} as State)
const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
let providerData: NormalizedProviderListResponse | undefined = provider

const queryOptionsApi = {
  globalConfig: () => ({ queryKey: ["globalConfig"], queryFn: async () => ({}) }),
  projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  providers: (directory: string | null) => ({ queryKey: [directory, "providers"], queryFn: async () => provider }),
  path: (directory: string | null) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({
      state: "",
      config: "",
      worktree: "",
      directory: directory ?? "",
      home: "",
    }),
  }),
  agents: (directory: string) => ({ queryKey: [directory, "agents"], queryFn: async () => [] }),
  lsp: (directory: string) => ({ queryKey: [directory, "lsp"], queryFn: async () => [] }),
  sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
} as unknown as QueryOptionsApi

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(async () => {
  mock.module("@tanstack/solid-query", () => ({
    useQuery: (options: () => { queryKey?: unknown[]; enabled?: boolean }) => {
      querySingles.push(options)
      return {
        get isLoading() {
          return options().queryKey?.[1] === "path"
        },
        get data() {
          if (options().queryKey?.[1] === "path") throw new Error("pending path data read")
          if (options().queryKey?.[1] === "lsp") return []
          if (options().queryKey?.[1] === "providers") return providerData
          return undefined
        },
      }
    },
  }))

  createChildStoreManager = (await import("./child-store")).createChildStoreManager
})

beforeEach(() => {
  providerData = provider
})

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      scope: ServerScope.local,
      persist,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {},
      translate: (key) => key,
      queryOptions: queryOptionsApi,
      global: { provider },
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("starts new child stores as loading and bootstraps them on first access", () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project")

      expect(store.status).toBe("loading")
      expect(store.limit).toBe(5)
      expect(bootstraps).toEqual(["/project"])
    } finally {
      dispose()
    }
  })

  test("provides the requested directory while the path query is pending", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.path.directory).toBe("/project")
      expect(store.path.worktree).toBe("")
    } finally {
      dispose()
    }
  })

  test("falls back to the global provider catalog when a project refresh has no data", () => {
    const fallback = {
      all: new Map([["fallback", { id: "fallback" }]]),
      connected: ["fallback"],
      default: {},
    } as unknown as NormalizedProviderListResponse
    providerData = undefined
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: fallback },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      expect(manager.child("/project")[0].provider).toBe(fallback)
    } finally {
      dispose()
    }
  })

  test("keeps non-bootstrapping children passive until a real directory access", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length
    const bootstraps: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store] = manager.child("/project", { bootstrap: false })
      const queries = querySingles.slice(offset)

      expect(queries).toHaveLength(3)
      expect(queries[0]?.().enabled).toBe(false)
      expect(queries[1]?.().enabled).toBe(false)
      expect(queries[2]?.().enabled).toBe(false)
      expect(store.path.directory).toBe("/project")
      expect(store.provider_ready).toBe(false)
      expect(store.lsp_ready).toBe(false)
      expect(bootstraps).toEqual([])

      manager.child("/project")
      expect(queries[0]?.().enabled).toBe(true)
      expect(queries[1]?.().enabled).toBe(true)
      expect(queries[2]?.().enabled).toBe(true)
      expect(bootstraps).toEqual(["/project"])

      manager.child("/project", { bootstrap: false })
      expect(queries[0]?.().enabled).toBe(true)
    } finally {
      dispose()
    }
  })

  test("coalesces overlapping Home hydration plans for one server context", async () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      await Promise.all([manager.hydrateDirectories(["/two", "/one"]), manager.hydrateDirectories(["/one", "/two"])])
      await manager.hydrateDirectories(["/one", "/two"])

      expect(bootstraps).toEqual(["/one", "/two"])
    } finally {
      dispose()
    }
  })

  test("cancels queued hydration when the server context is disposed", async () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })
    if (!manager) throw new Error("manager required")

    const hydration = manager.hydrateDirectories(["/one", "/two"])
    dispose()
    await hydration

    expect(bootstraps).toEqual([])
  })

  test("waits for one directory bootstrap before starting the next", async () => {
    const phases: string[] = []
    let active = 0
    let maxActive = 0
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        async onBootstrap(directory) {
          phases.push(`start:${directory}`)
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
          active -= 1
          phases.push(`complete:${directory}`)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })
    if (!manager) throw new Error("manager required")

    try {
      await manager.hydrateDirectories(["/two", "/one"])
      expect(maxActive).toBe(1)
      expect(phases).toEqual(["start:/one", "complete:/one", "start:/two", "complete:/two"])
    } finally {
      dispose()
    }
  })
})
