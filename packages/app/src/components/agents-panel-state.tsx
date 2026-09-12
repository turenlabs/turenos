// Shared state for the Agents panel (the `home-left-nav` project/session
// column). Wave 2 of the shell direction in .interface-design/system.md lifts
// the panel out of the home route and into the persistent shell so it renders
// on session and draft routes too. This provider owns the state the
// panel needs everywhere — project selection, the home session index, and the
// open/create/edit actions — and the home page consumes the very same context
// for its stacked (narrow) variant and session list, so both mounts stay one
// state.
//
// It deliberately renders nothing: the desktop panel markup stays in
// pages/home.tsx (AgentsProjectColumn) and is mounted by
// components/agents-panel.tsx inside pages/layout-new.tsx.

import type { Session } from "@turenlabs/sdk/v2/client"
import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { useLocation, useNavigate } from "@solidjs/router"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { createSimpleContext } from "@turenlabs/ui/context"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useServerManagementController } from "@/components/dialog-select-server"
import { useLayout, type HomeProjectSelection, type LocalProject } from "@/context/layout"
import { serverForAvailableSelection, ServerConnection, useServer } from "@/context/server"
import { useTabs, type DraftTab } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useGlobal } from "@/context/global"
import { useNotification } from "@/context/notification"
import {
  closeHomeProject,
  displayName,
  errorMessage,
  homeProjectDirectories,
  projectForSession,
  toggleHomeProjectSelection,
} from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"
import { Persist, persisted } from "@/utils/persist"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { archivedHomeSessionEvent } from "@/pages/home-session-archive"
import * as SessionActions from "@/pages/home-session-actions"
import { prioritizeHomeSessionRecords, recentHomeSessionRecords, sessionOrigin } from "@/pages/home-session-origin"
import {
  HOME_V2_SESSION_LIMIT,
  loadHomeSessionIndex,
  parseHomeSessionIndex,
  removedHomeSessionEvent,
  toLegacySummary,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"

export const HOME_SESSION_LIMIT = 8

export const HOME_SECONDARY_SESSION_LIMIT = 1_000

export const homeArchivedSessionsKey = (server: string, directory: string) =>
  ["home", "archived-sessions", server, directory] as const
export const homeInactiveSessionsKey = (server: string, directory: string) =>
  ["home", "inactive-sessions", server, directory] as const

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type OpenSessionOptions = { background?: boolean }

export function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}): HomeSessionRecord[] {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const all = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(all.map((session) => [session.id, session] as const)).values()]
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return {
        session,
        project,
        projectName: displayName(project),
      }
    })
}

export const { use: useAgentsPanel, provider: AgentsPanelProvider } = createSimpleContext({
  name: "AgentsPanel",
  gate: false,
  init: () => {
    const layout = useLayout()
    const dialog = useDialog()
    const navigate = useNavigate()
    const location = useLocation()
    const server = useServer()
    const language = useLanguage()
    const global = useGlobal()
    const tabs = useTabs()
    const sync = useServerSync()
    const notification = useNotification()
    const pickDirectory = useDirectoryPicker()
    const serverController = useServerManagementController({ navigateOnAdd: false })

    const [_serverNavState, setServerNavState, _, serverNavReady] = persisted(
      Persist.global("home.servers", ["home.servers.v1"]),
      createStore({
        collapsed: {} as Record<string, boolean>,
        pinnedSessions: {} as Record<string, string[]>,
      }),
    )
    const [serverNavState] = createResource(
      () => serverNavReady.promise ?? Promise.resolve(),
      (ready) => ready.then(() => _serverNavState),
      { initialValue: _serverNavState },
    )

    const selection = layout.home.selection

    const focusedServer = createMemo(
      () =>
        serverForAvailableSelection({
          servers: global.servers.list(),
          health: global.servers.health,
          selected: selection().server,
          fallback: server.key,
        }) ?? server.current,
    )
    const focusedServerCtx = createMemo(() => {
      const conn = focusedServer()
      if (!conn) return
      if (global.servers.health[ServerConnection.key(conn)]?.healthy !== true) return
      return global.ensureServerCtx(conn)
    })
    const focusedSync = () => focusedServerCtx()?.sync ?? sync()
    const homeSessions = () => focusedSync().homeSessions
    const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
    const recentlyClosed = createMemo(
      () => focusedServerCtx()?.projects.recentlyClosed() ?? layout.projects.recentlyClosed(),
    )
    const homedir = createMemo(() => focusedSync().data.path.home ?? "")
    const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
    const newSessionProject = createMemo(
      () =>
        selectedProject() ??
        projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
        projects()[0],
    )
    const canOpenNewSession = createMemo(() => {
      const conn = focusedServer()
      if (!conn || !newSessionProject()) return false
      return global.servers.health[ServerConnection.key(conn)]?.healthy !== false
    })
    const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]
    const projectDirectories = createMemo(() => {
      const project = selectedProject()
      if (!project) return projects().flatMap(directories)
      return directories(project)
    })

    // The panel mounts under a second QueryClientProvider (the ServerShell client),
    // but the home index is written by the server event stream through
    // homeSessions.apply on the ctx's own client. Register these queries on that
    // same client so live session.created/updated/deleted events are visible here;
    // reading the ambient client left the index frozen at its first fetch (new
    // sessions never appeared, deletions never pruned). Every server ctx shares one
    // app-wide client, so this accessor is stable across focus changes.
    const indexQueryClient = () => homeSessions().queryClient
    const sessionEventLoad = useQuery(
      () => ({
        queryKey: homeSessions().eventsKey,
        queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
        initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
        enabled: false,
      }),
      indexQueryClient,
    )
    const sessionLoad = useQuery(
      () => ({
        queryKey: homeSessions().indexKey,
        enabled: !!focusedServerCtx(),
        queryFn: async ({ signal }) => {
          const conn = focusedServer()
          const ctx = focusedServerCtx()
          if (!ctx || !conn) return { sessions: [], eventSequence: 0, server: undefined }
          const cache = homeSessions()
          const eventSequence = cache.eventSequence()
          const index = await loadHomeSessionIndex(
            (input, options) => ctx.sdk.client.v2.session.list(input, options),
            eventSequence,
            signal,
          )
          cache.complete(eventSequence)
          return { ...index, server: ServerConnection.key(conn) }
        },
        retry: false,
        staleTime: 30_000,
        refetchOnMount: true,
        refetchOnReconnect: true,
      }),
      indexQueryClient,
    )

    const agingTimer = setInterval(() => {
      void indexQueryClient().invalidateQueries({ queryKey: homeSessions().indexKey, exact: true })
      void indexQueryClient().invalidateQueries({
        queryKey: homeInactiveSessionsKey(selection().server ?? "", selection().directory ?? ""),
        exact: true,
      })
    }, 60_000)
    onCleanup(() => clearInterval(agingTimer))

    const [inactiveFor, setInactiveFor] = createSignal<string | undefined>()
    const inactiveKey = () => `${selection().server}::${selection().directory ?? ""}`
    const inactiveOpen = () => inactiveFor() === inactiveKey()
    const toggleInactive = () => setInactiveFor(inactiveOpen() ? undefined : inactiveKey())

    const inactiveLoad = useQuery(
      () => ({
        queryKey: homeInactiveSessionsKey(selection().server ?? "", selection().directory ?? ""),
        enabled: inactiveOpen() && !!focusedServerCtx() && !!selectedProject(),
        queryFn: async ({ signal }) => {
          const ctx = focusedServerCtx()
          const project = selectedProject()
          if (!ctx || !project) return [] as Session[]
          const scope = project.id ? { project: project.id } : { directory: project.worktree }
          const response = await ctx.sdk.client.v2.session.list(
            {
              ...scope,
              archived: "false",
              inactive: "true",
              roots: true,
              limit: HOME_SECONDARY_SESSION_LIMIT,
              order: "desc" as const,
            },
            { signal },
          )
          return parseHomeSessionIndex(response.data?.data ?? [])
        },
        retry: false,
        staleTime: 15_000,
      }),
      indexQueryClient,
    )

    // Which project's Archived group is expanded, as "<server>::<directory>".
    // Keying on the selection rather than a boolean collapses the group by
    // itself when the user moves to another project.
    const [archivedFor, setArchivedFor] = createSignal<string | undefined>()
    const archivedKey = () => `${selection().server}::${selection().directory ?? ""}`
    const archivedOpen = () => archivedFor() === archivedKey()
    const toggleArchived = () => setArchivedFor(archivedOpen() ? undefined : archivedKey())

    const archivedLoad = useQuery(
      () => ({
        queryKey: homeArchivedSessionsKey(selection().server ?? "", selection().directory ?? ""),
        enabled: archivedOpen() && !!focusedServerCtx() && !!selectedProject(),
        queryFn: async ({ signal }) => {
          const ctx = focusedServerCtx()
          const project = selectedProject()
          if (!ctx || !project) return [] as Session[]
          const scope = project.id ? { project: project.id } : { directory: project.worktree }
          const response = await ctx.sdk.client.v2.session.list(
            {
              ...scope,
              archived: "true",
              roots: true,
              limit: HOME_SECONDARY_SESSION_LIMIT,
              order: "desc" as const,
            },
            { signal },
          )
          return SessionActions.archivedSessions(response.data?.data ?? [])
        },
        retry: false,
        staleTime: 15_000,
      }),
      indexQueryClient,
    )

    const projectByID = createMemo(
      () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
    )
    const indexedSessionList = createMemo(() => homeSessions().sessions(sessionLoad.data, sessionEventLoad.data))
    const allProjectRecords = createMemo(() =>
      buildHomeSessionRecords({
        // Keep the complete lightweight summary index available for search and
        // explicit navigation. The rendered projection below is bounded.
        sessions: indexedSessionList,
        projectDirectories: () => projects().flatMap(directories),
        projects,
        projectByID,
      }),
    )
    const pinnedSessionIDsFor = (key: string) => {
      const ids = serverNavState().pinnedSessions[key]
      return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []
    }
    const focusRecords = createMemo(() => {
      const conn = focusedServer()
      if (!conn) return allProjectRecords().slice(0, HOME_SESSION_LIMIT)
      const data = focusedSync().session.data
      const serverKey = ServerConnection.key(conn)
      const notifications = notification.ensureServerState(serverKey)
      const selectedDirectory = selection().directory
      const parentByID = new Map(
        Object.values(data.info).flatMap((session) =>
          session?.parentID ? [[session.id, session.parentID] as const] : [],
        ),
      )
      const rootID = (id: string) => {
        const seen = new Set<string>()
        let current = id
        while (!seen.has(current)) {
          seen.add(current)
          const parent = parentByID.get(current)
          if (!parent) return current
          current = parent
        }
        return current
      }
      const attentionRoots = new Set(
        [...Object.entries(data.permission), ...Object.entries(data.question)]
          .filter(([, requests]) => requests.length > 0)
          .map(([id]) => rootID(id)),
      )
      const workingRoots = new Set(
        Object.entries(data.session_status)
          .filter(([, status]) => status.type !== "idle")
          .map(([id]) => rootID(id)),
      )
      const focused = allProjectRecords().flatMap((record) => {
        const root = rootID(record.session.id)
        const origin = sessionOrigin(record.session)
        const selectedProject = !!selectedDirectory && pathKey(record.project.worktree) === pathKey(selectedDirectory)
        if (attentionRoots.has(root) || (notifications?.session.unseenHasError(record.session.id) ?? false))
          return [{ record, priority: 0 }]
        if (origin === "manual" && workingRoots.has(root)) return [{ record, priority: 1 }]
        if (origin === "manual" && !selectedProject && (notifications?.session.unseenCount(record.session.id) ?? 0) > 0)
          return [{ record, priority: 2 }]
        return []
      })
      return prioritizeHomeSessionRecords(focused, (item) => item.priority, HOME_SESSION_LIMIT).map(
        (item) => item.record,
      )
    })
    const allRecords = createMemo(() => {
      const allowed = new Set(projectDirectories().map(pathKey))
      return allProjectRecords().filter((record) => allowed.has(pathKey(record.session.directory)))
    })
    const pinnedSessionIDs = () => pinnedSessionIDsFor(selection().server ?? "")
    const records = createMemo(() => {
      const prioritized = focusRecords()
      const selected = new Set(prioritized.map((record) => record.session.id))
      const pinned = new Set(pinnedSessionIDs())
      const recent = recentHomeSessionRecords(
        allRecords().filter((record) => !selected.has(record.session.id) && !pinned.has(record.session.id)),
        allRecords().length,
      )
      return [...prioritized, ...recent].filter(
        (record, index, records) => records.findIndex((item) => item.session.id === record.session.id) === index,
      )
    })
    const [hydratedPinnedRecords, setHydratedPinnedRecords] = createSignal<HomeSessionRecord[]>([])
    let pinnedHydrationRevision = 0
    createEffect(() => {
      const ctx = focusedServerCtx()
      const ids = pinnedSessionIDs()
      const indexed = new Set(allProjectRecords().map((record) => record.session.id))
      const missing = ids.filter((id) => !indexed.has(id))
      const revision = ++pinnedHydrationRevision
      if (!ctx || missing.length === 0) {
        setHydratedPinnedRecords([])
        return
      }
      void Promise.all(
        missing.map(async (id) => {
          try {
            const response = await ctx.sdk.client.v2.session.get({ sessionID: id })
            return response.data?.data
          } catch {
            return undefined
          }
        }),
      ).then((sessions) => {
        if (revision !== pinnedHydrationRevision) return
        setHydratedPinnedRecords(
          buildHomeSessionRecords({
            sessions: () =>
              sessions
                .filter((session): session is NonNullable<typeof session> => !!session)
                .filter((session) => typeof session.time.archived !== "number")
                .map((session) => toLegacySummary(session)),
            projectDirectories: () => projects().flatMap(directories),
            projects,
            projectByID,
          }),
        )
      })
    })
    const pinnedRecords = createMemo(() => {
      const indexed = new Map(
        [...allProjectRecords(), ...hydratedPinnedRecords()].map((record) => [record.session.id, record]),
      )
      return pinnedSessionIDs().flatMap((id) => (indexed.has(id) ? [indexed.get(id)!] : []))
    })

    async function searchSessions(query: string, signal?: AbortSignal) {
      const conn = focusedServer()
      const ctx = focusedServerCtx()
      if (!conn || !ctx || !query) return []
      const project = selectedProject()
      const response = await ctx.sdk.client.v2.session.list(
        {
          limit: 1000,
          order: "desc",
          roots: true,
          search: query,
          ...(project?.id ? { project: project.id } : {}),
        },
        { signal },
      )
      return buildHomeSessionRecords({
        sessions: () => parseHomeSessionIndex(response.data?.data ?? []),
        projectDirectories: () => (project ? directories(project) : projects().flatMap(directories)),
        projects,
        projectByID,
      })
    }

    function pinSession(session: Session) {
      const key = selection().server
      if (!key || pinnedSessionIDs().includes(session.id)) return
      setServerNavState("pinnedSessions", key, [...pinnedSessionIDs(), session.id])
    }

    function unpinSession(session: Session, serverKey = selection().server) {
      const key = serverKey
      if (!key) return
      const ids = pinnedSessionIDsFor(key)
      setServerNavState(
        "pinnedSessions",
        key,
        ids.filter((id) => id !== session.id),
      )
    }

    // Keep the selection anchored to a server that still exists.
    createEffect(() => {
      const list = global.servers.list()
      const conn = serverForAvailableSelection({
        servers: list,
        health: global.servers.health,
        selected: selection().server,
        fallback: server.key,
      })
      if (conn && ServerConnection.key(conn) !== selection().server) {
        setSelection({ server: ServerConnection.key(conn) })
      }
    })

    function setSelection(next: HomeProjectSelection) {
      layout.home.setSelection(next)
    }

    // Anchor the left nav to the active tab: a session tab selects its project
    // so the nav expands its session list, and the matching row highlights
    // itself off the same route (HomeNavSessionRow in home.tsx). Applied once
    // per tab activation — reselecting a project by hand while the same tab
    // stays open is not overridden.
    let appliedNavTab: string | undefined
    createEffect(() => {
      const route = layout.route()
      const target = ((): { key: ServerConnection.Key; directory?: string; id?: string } | undefined => {
        if (route.type === "draft") {
          const draft = tabs.store.find(
            (tab): tab is DraftTab => tab.type === "draft" && tab.draftID === route.draftID,
          )
          if (!draft) return undefined
          return { key: route.server ?? server.key, directory: draft.directory, id: `draft:${route.draftID}` }
        }
        if (route.type !== "session") return undefined
        const key = route.server ?? server.key
        const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
        if (!conn) return { key }
        const ctx = global.ensureServerCtx(conn)
        const session =
          ctx.sync.session.get(route.sessionId) ??
          allProjectRecords().find((record) => record.session.id === route.sessionId)?.session
        if (!session) return { key }
        return {
          key,
          directory: projectForSession(session, ctx.projects.list())?.worktree ?? session.directory,
          id: `session:${key}:${route.sessionId}`,
        }
      })()
      if (!target) {
        appliedNavTab = undefined
        return
      }
      if (target.id && appliedNavTab === target.id) return
      const current = selection()
      if (!target.directory) {
        if (current.server !== target.key) setSelection({ server: target.key })
        return
      }
      if (current.server !== target.key || current.directory !== target.directory) {
        setSelection({ server: target.key, directory: target.directory })
      }
      appliedNavTab = target.id
    })

    // The session search box lives on the home page; the panel's search action
    // has to work from every route. Home binds its focus function while
    // mounted; from other routes we navigate home first and focus once the
    // binding arrives.
    let searchFocus: (() => void) | undefined
    let pendingSearchFocus = false

    function bindSearchFocus(focus: (() => void) | undefined) {
      searchFocus = focus
      if (focus && pendingSearchFocus) {
        pendingSearchFocus = false
        requestAnimationFrame(() => focus())
      }
    }

    function focusSearch() {
      if (location.pathname !== "/") {
        pendingSearchFocus = true
        navigate("/")
        return
      }
      requestAnimationFrame(() => searchFocus?.())
    }

    function focusServer(conn: ServerConnection.Any) {
      setSelection({ server: ServerConnection.key(conn) })
    }

    function selectProject(conn: ServerConnection.Any, directory: string) {
      const key = ServerConnection.key(conn)
      if (global.servers.health[key]?.healthy === false) return
      const ctx = global.ensureServerCtx(conn)
      if (!ctx.projects.list().some((project) => project.worktree === directory)) return
      const next = toggleHomeProjectSelection(selection(), key, directory)
      if (next.directory) ctx.projects.touch(directory)
      setSelection(next)
    }

    function addProjects(conn: ServerConnection.Any, directories: string[]) {
      const directory = directories[0]
      if (!directory) return
      const ctx = global.ensureServerCtx(conn)
      directories.forEach(ctx.projects.open)
      ctx.projects.touch(directory)
      setSelection({ server: ServerConnection.key(conn), directory })
    }

    function openNewSession() {
      const conn = focusedServer()
      const project = newSessionProject()
      if (!conn || !project || !canOpenNewSession()) return
      openProjectNewSession(conn, project.worktree)
    }

    function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
      if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
      const ctx = global.ensureServerCtx(conn)
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
      void tabs.newDraft({ server: ServerConnection.key(conn), directory })
    }

    function editProject(conn: ServerConnection.Any, project: LocalProject) {
      void import("@/components/dialog-edit-project-v2").then((x) => {
        void dialog.show(() => <x.DialogEditProjectV2 server={conn} project={project} />)
      })
    }

    function unseenCount(conn: ServerConnection.Any, project: LocalProject) {
      const state = notification.ensureServerState(ServerConnection.key(conn))
      if (!state) return 0
      return directories(project).reduce((total, directory) => total + state.project.unseenCount(directory), 0)
    }

    function clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
      const state = notification.ensureServerState(ServerConnection.key(conn))
      if (!state) return
      directories(project)
        .filter((directory) => state.project.unseenCount(directory) > 0)
        .forEach((directory) => state.project.markViewed(directory))
    }

    function openSession(session: Session, options?: OpenSessionOptions) {
      const directoryKey = pathKey(session.directory)
      const project =
        projects().find(
          (item) =>
            pathKey(item.worktree) === directoryKey ||
            item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
        ) ?? projectForSession(session, projects(), projectByID())
      const conn = focusedServer()
      if (!conn) return
      const directory = project?.worktree ?? session.directory
      const ctx = global.ensureServerCtx(conn)
      // The home index already returned the complete session. Seed the server-wide
      // cache before navigating so the target route does not have to race a detail
      // request against a newly-created or eventually-consistent session record.
      ctx.sync.session.remember(session)
      ctx.projects.open(directory)
      if (options?.background) {
        tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
        return
      }
      ctx.projects.touch(directory)
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
    }

    // --- Session lifecycle -------------------------------------------------
    //
    // Every action below routes through pages/home-session-actions.ts, which
    // rejects unless the server's own record confirms the change. Only after
    // that do we touch local state, so the sidebar can never show an outcome
    // the server did not actually apply. Failures surface as an error toast
    // (or inline in the dialog) rather than being swallowed.

    type FocusedCtx = NonNullable<ReturnType<typeof focusedServerCtx>>

    const lifecycleClient = (ctx: FocusedCtx): SessionActions.SessionLifecycleClient => ({
      session: {
        get: (input) => ctx.sdk.client.session.get(input),
        update: (input) => ctx.sdk.client.session.update(input),
        delete: (input) => ctx.sdk.client.session.delete(input),
      },
    })

    const actionFailed = (titleKey: Parameters<typeof language.t>[0], err: unknown) =>
      showToast({
        variant: "error",
        title: language.t(titleKey),
        description: errorMessage(err, language.t("common.requestFailed")),
      })

    // Apply the value the mutation returned AND invalidate, rather than relying
    // on the SSE event arriving: the stream can be missed across reconnects and
    // on remote servers.
    const applyIndex = (ctx: FocusedCtx, event: Parameters<FocusedCtx["sync"]["homeSessions"]["apply"]>[0]) => {
      ctx.sync.homeSessions.apply(event)
      void ctx.sync.homeSessions.queryClient.invalidateQueries({ queryKey: ctx.sync.homeSessions.indexKey })
    }

    const refreshArchived = () =>
      void indexQueryClient().invalidateQueries({
        queryKey: homeArchivedSessionsKey(selection().server ?? "", selection().directory ?? ""),
      })
    const refreshInactive = () =>
      void indexQueryClient().invalidateQueries({
        queryKey: homeInactiveSessionsKey(selection().server ?? "", selection().directory ?? ""),
      })

    const displaySessionName = (session: Session) => sessionTitle(session.title) || language.t("command.session.new")

    function renameSession(session: Session) {
      const ctx = focusedServerCtx()
      if (!ctx) return
      void import("@/components/dialog-session-actions").then((mod) => {
        void dialog.show(() => (
          <mod.DialogRenameSession
            title={session.title}
            submit={async (title) => {
              const updated = await SessionActions.renameSession({
                client: lifecycleClient(ctx),
                sessionID: session.id,
                directory: session.directory,
                title,
              })
              ctx.sync.session.remember(updated)
              applyIndex(ctx, { type: "session.updated", properties: { sessionID: updated.id, info: updated } })
              refreshInactive()
            }}
          />
        ))
      })
    }

    async function archiveSession(session: Session) {
      const conn = focusedServer()
      const ctx = focusedServerCtx()
      if (!conn || !ctx) return
      try {
        const updated = await SessionActions.setSessionArchived({
          client: lifecycleClient(ctx),
          sessionID: session.id,
          directory: session.directory,
          archived: Date.now(),
        })
        unpinSession(session, ServerConnection.key(conn))
        applyIndex(ctx, archivedHomeSessionEvent(session, updated.time.archived ?? Date.now()))
        refreshInactive()
        refreshArchived()
        notifySessionTabsRemoved({
          server: ServerConnection.key(conn),
          directory: session.directory,
          sessionIDs: [session.id],
        })
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.archive.success.title"),
          description: language.t("session.archive.success.description"),
        })
      } catch (err) {
        actionFailed("session.archive.failed.title", err)
      }
    }

    async function restoreSession(session: Session) {
      const ctx = focusedServerCtx()
      if (!ctx) return
      try {
        const updated = await SessionActions.setSessionArchived({
          client: lifecycleClient(ctx),
          sessionID: session.id,
          directory: session.directory,
          archived: null,
        })
        ctx.sync.session.remember(updated)
        applyIndex(ctx, SessionActions.restoredHomeSessionEvent(updated))
        refreshInactive()
        refreshArchived()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.restore.success.title"),
        })
      } catch (err) {
        actionFailed("session.restore.failed.title", err)
      }
    }

    function deleteSession(session: Session) {
      const conn = focusedServer()
      const ctx = focusedServerCtx()
      if (!conn || !ctx) return
      void import("@/components/dialog-session-actions").then((mod) => {
        void dialog.show(() => (
          <mod.DialogDeleteSession
            name={displaySessionName(session)}
            submit={async () => {
              await SessionActions.deleteSession({
                client: lifecycleClient(ctx),
                sessionID: session.id,
                directory: session.directory,
              })
              // Order matters. Once the delete is confirmed the session is gone
              // for good, so the two updates that would strand the user run
              // first and with nothing fallible between them: closing every tab
              // pointing at it (active or background — a stranded background tab
              // renders the not-found fallback) and pruning the sidebar's index.
              notifySessionTabsRemoved({
                server: ServerConnection.key(conn),
                directory: session.directory,
                sessionIDs: [session.id],
              })
              unpinSession(session, ServerConnection.key(conn))
              applyIndex(ctx, removedHomeSessionEvent(session.id))
              // Cache housekeeping. Best effort by design: a session that is
              // already deleted must not end up looking undeleted because an
              // eviction threw.
              try {
                ctx.sync.session.evict(session.id)
                refreshInactive()
                refreshArchived()
              } catch {
                // Nothing actionable — the authoritative state is already applied.
              }
              showToast({
                variant: "success",
                icon: "circle-check",
                title: language.t("session.delete.success.title"),
              })
            }}
          />
        ))
      })
    }

    function chooseProject(conn: ServerConnection.Any) {
      if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return

      function resolve(result: string | string[] | null) {
        addProjects(conn, homeProjectDirectories(result))
      }

      pickDirectory({
        server: conn,
        title: language.t("command.project.open"),
        multiple: true,
        onSelect: resolve,
      })
    }

    function closeProject(conn: ServerConnection.Any, directory: string) {
      const next = closeHomeProject(
        selection(),
        ServerConnection.key(conn),
        global.ensureServerCtx(conn).projects,
        directory,
      )
      if (next) setSelection(next)
    }

    return {
      selection,
      setSelection,
      focusedServer,
      focusedServerCtx,
      projects,
      recentlyClosed,
      homedir,
      selectedProject,
      newSessionProject,
      canOpenNewSession,
      allProjectRecords,
      focusRecords,
      allRecords,
      records,
      pinnedRecords,
      searchSessions,
      isSessionPinned: (session: Session) => pinnedSessionIDs().includes(session.id),
      pinSession,
      unpinSession,
      sessionsLoading: () => sessionLoad.isPending,
      serverController,
      serverCollapsed: (key: ServerConnection.Key) => !!serverNavState().collapsed[key],
      toggleServerCollapsed: (key: ServerConnection.Key) =>
        setServerNavState("collapsed", key, !serverNavState().collapsed[key]),
      bindSearchFocus,
      focusSearch,
      focusServer,
      selectProject,
      addProjects,
      openNewSession,
      openProjectNewSession,
      editProject,
      unseenCount,
      clearNotifications,
      openSession,
      chooseProject,
      closeProject,
      renameSession,
      archiveSession,
      restoreSession,
      deleteSession,
      inactiveOpen,
      toggleInactive,
      inactiveSessions: () => inactiveLoad.data ?? [],
      inactiveLoading: () => inactiveLoad.isFetching,
      inactiveFailed: () => inactiveLoad.isError,
      archivedOpen,
      toggleArchived,
      archivedSessions: () => archivedLoad.data ?? [],
      archivedLoading: () => archivedLoad.isFetching,
      archivedFailed: () => archivedLoad.isError,
    }
  },
})
