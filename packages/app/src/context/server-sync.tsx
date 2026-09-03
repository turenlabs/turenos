import type { Config, ForgeClient, Path, Project, ProviderAuthResponse } from "@turenlabs/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@turenlabs/core/util/path"
import { type Accessor, batch, createMemo, createSignal, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_INITIAL_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@turenlabs/ui/context"
import { NormalizedProviderListResponse } from "@turenlabs/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import type { ServerScope } from "@/utils/server-scope"
import { createHomeSessionIndexCache } from "./global-sync/home-session-index"
import { isSharedProject, localProjectMeta } from "./project-enrich"
import { Persist, persisted } from "@/utils/persist"
import { createServerSession } from "./server-session"
import { notifySessionTabsRemoved, sessionTabsRemovedForServerEvent } from "@/components/titlebar-session-events"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: ForgeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(scope: ServerScope, serverSDK: () => ForgeClient, sdkFor: (dir: PathKey) => ForgeClient) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    projects: () => loadProjectsQuery(scope, serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, sdkFor(directory)),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const [providerPreferences, setProviderPreferences] = persisted(
    Persist.serverGlobal(serverSDK.scope, "provider-picker"),
    createStore({ excluded: [] as string[] }),
  )

  const sdkCache = new Map<string, ForgeClient>()
  const booting = new Map<string, Promise<void>>()
  const [bootingRevision, setBootingRevision] = createSignal(0)
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    provider_auth: {},
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()
  const homeSessions = createHomeSessionIndexCache(queryClient, ServerConnection.key(serverSDK.server))

  // Global providers live at [scope, null, "providers"], per-directory ones at
  // [scope, directory, "providers"]; index 2 matches both. Anything that changes
  // which providers are connected must refresh every one of them, otherwise the
  // UI only catches up if a server event happens to arrive.
  const refreshProviders = () =>
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })

  // Core republishes `catalog.updated` after its hourly catalog refresh and after each
  // provider probe settles. Without a consumer, a model that appears after boot (a probe
  // finishing late) never reaches the composer picker until something else happens to
  // call refreshProviders(). Probes settle in a burst around startup, so coalesce.
  let providerRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleProviderRefresh = () => {
    if (providerRefreshTimer !== undefined) return
    providerRefreshTimer = setTimeout(() => {
      providerRefreshTimer = undefined
      void refreshProviders()
    }, 500)
  }

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
    if (providerRefreshTimer !== undefined) clearTimeout(providerRefreshTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const session = createServerSession(serverSDK.client)

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { limit?: number }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit, SESSION_INITIAL_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => serverSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: session.data.permission,
              })
              batch(() => {
                next.forEach(session.remember)
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        session,
      })
    })

    booting.set(key, promise)
    setBootingRevision((revision) => revision + 1)
    void promise.finally(() => {
      booting.delete(key)
      setBootingRevision((revision) => revision + 1)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    session.apply(event, directory)
    const removedTabs = sessionTabsRemovedForServerEvent({
      server: ServerConnection.key(serverSDK.server),
      directory,
      event,
    })
    if (removedTabs) notifySessionTabsRemoved(removedTabs)
    if (event.type === "catalog.updated") scheduleProviderRefresh()
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
      homeSessions.apply(event)
    }
    homeSessions.refresh(event.type)

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          if (!children.active(directory)) continue
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: (directory) => {
        if (children.active(directory)) queue.push(directory)
      },
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const resolveProjectID = async (directory: string) => {
    const known = children.children[directoryKey(directory)]?.[0].project
    if (known) return known
    const listed = globalStore.project.find(
      (item) => item.worktree === directory || item.sandboxes?.includes(directory),
    )
    if (listed) return listed.id
    const response = await sdkFor(directory).project.current()
    return response.data?.id
  }

  /**
   * Editing a project writes to one of two places, because not every project
   * the UI lists owns a row of its own:
   *
   * - A project with a real id owns a server row, so its name, icon and
   *   commands persist there and come back as a `project.updated` event.
   * - Directories that are not git repositories all resolve to the single
   *   shared `global` row, so a name written there would rename every one of
   *   them at once. Those get the per-worktree local override instead, which
   *   `enrichProject` layers back over the shared row so the edit is visible.
   *
   * The response is applied here instead of waiting for `project.updated`: that
   * event is otherwise the only thing that surfaces the change, so any gap in
   * the stream would leave the UI showing the old value until the next reload
   * even though the database is already correct.
   */
  const updateProject = async (input: {
    directory: string
    projectID?: string
    name?: string
    icon?: Project["icon"]
    commands?: Project["commands"]
  }) => {
    const projectID = input.projectID ?? (await resolveProjectID(input.directory))
    if (isSharedProject(projectID)) {
      children.projectMeta(input.directory, localProjectMeta(input))
      return
    }

    const response = await serverSDK.client.project.update({
      projectID,
      directory: input.directory,
      name: input.name,
      icon: input.icon,
      commands: input.commands,
    })
    const next = response.data
    if (next) {
      applyGlobalEvent({
        event: { type: "project.updated", properties: next },
        project: globalStore.project,
        setGlobalProject: setProjects,
        refresh: () => {},
      })
    }
    void queryClient.invalidateQueries({ queryKey: [serverSDK.scope, "project"] })
  }

  const projectApi = {
    loadSessions,
    update: updateProject,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Configuration changes can affect provider visibility across every directory.
      void refreshProviders()
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    directoryState(directory: string) {
      bootingRevision()
      const store = children.peek(directory, { bootstrap: false })[0]
      return { status: store.status, bootstrapping: booting.has(directoryKey(directory)) }
    },
    hydrateDirectories: children.hydrateDirectories,
    peek: children.peek,
    queryOptions: queryOptionsApi,
    // bootstrap,
    refreshProviders,
    updateConfig: updateConfigMutation.mutateAsync,
    provider: {
      excluded: () => providerPreferences.excluded,
      exclude(providerID: string) {
        if (providerPreferences.excluded.includes(providerID)) return
        setProviderPreferences("excluded", [...providerPreferences.excluded, providerID])
      },
      include(providerID: string) {
        if (!providerPreferences.excluded.includes(providerID)) return
        setProviderPreferences(
          "excluded",
          providerPreferences.excluded.filter((id) => id !== providerID),
        )
      },
    },
    project: projectApi,
    session,
    homeSessions,
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      undefined,
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server ? props.server() : server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
