import type { Session } from "@turenlabs/sdk/v2/client"
import {
  type ComponentProps,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createStore, produce } from "solid-js/store"
import { Button } from "@turenlabs/ui/button"
import { Logo } from "@turenlabs/ui/logo"
import { Spinner } from "@turenlabs/ui/spinner"
import { Thinking } from "@turenlabs/ui/thinking"
import { ScrollView } from "@turenlabs/ui/scroll-view"
import { ProjectAvatar } from "@turenlabs/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { IconButtonV2 } from "@turenlabs/ui/v2/icon-button-v2"
import { MenuV2 } from "@turenlabs/ui/v2/menu-v2"
import { TooltipV2 } from "@turenlabs/ui/v2/tooltip-v2"
import { getProjectAvatarVariant, useLayout, type HomeProjectSelection, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@turenlabs/core/util/encode"
import { Icon } from "@turenlabs/ui/icon"
import { usePlatform } from "@/context/platform"
import { useNotification } from "@/context/notification"
import { DateTime } from "luxon"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useSettingsCommand } from "@/components/settings-dialog"
import { PageHeader } from "@/components/page-header"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useNavRail } from "@/components/nav-rail"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { displayName, errorMessage, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useAgentsPanel, type HomeSessionRecord, type OpenSessionOptions } from "@/components/agents-panel-state"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { useGlobal } from "@/context/global"
import { directoryHydrationKey, directoryHydrationPlan } from "./home-directory-hydration"
import { useCommand, useCommandPalette } from "@/context/command"
import { usePermission } from "@/context/permission"
import { Binary } from "@turenlabs/core/util/binary"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useMarked } from "@turenlabs/ui/context/marked"
import { preloadMarkdown } from "@turenlabs/session-ui/markdown-cache"
import { archivedHomeSessionEvent, archiveHomeSession } from "./home-session-archive"
import { recentHomeSessionRecords, sessionOrigin, sessionOriginLabel } from "./home-session-origin"
import { shouldOpenSessionInBackground } from "./home-session-open"
import { showToast } from "@/utils/toast"
import { fileManagerApp } from "@/utils/file-manager"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { sessionNavStatus, type SessionNavStatus } from "@/pages/layout/session-nav-state"
import { LatestAutomationRuns } from "./loops/latest-runs"

const HOME_SESSION_HEADER_STICKY_TOP = 12
const HOME_SESSION_HEADER_TEXT_HEIGHT = 16
const HOME_SESSION_HEADER_FADE_DISTANCE = 16

function containHomeWheel(event: WheelEvent, viewport: HTMLElement) {
  if (event.defaultPrevented || event.ctrlKey || !event.deltaY) return
  if (!(event.target instanceof Element)) return

  const scrollable = event.target.closest<HTMLElement>("[data-scrollable]")
  if (
    scrollable !== viewport &&
    scrollable &&
    (event.deltaY < 0
      ? scrollable.scrollTop > 0
      : scrollable.scrollTop < scrollable.scrollHeight - scrollable.clientHeight)
  )
    return

  event.preventDefault()
}
const SHOW_HOME_SESSION_ARCHIVE = false
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-7 gap-2 px-1.5 [font-weight:440] text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base hover:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base data-[selected]:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:hover:bg-v2-background-bg-layer-03 focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"
const HOME_LEFT_NAV_ACTION = `${HOME_ROW_LAYOUT} h-9 gap-2.5 px-2.5 text-[13px] text-v2-text-text-base [font-weight:530] outline outline-1 outline-transparent hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent`
const HOME_LIBRARY_CHIP =
  "flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-full border-0 px-2 text-[10.5px] text-v2-text-text-faint transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out [font-weight:530] [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] hover:text-v2-text-text-muted data-[active]:bg-v2-background-bg-layer-03 data-[active]:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"
const HOME_SEARCH_RESULT_ROW =
  "flex h-10 w-full shrink-0 cursor-default items-center gap-2 border-0 py-3 pl-[18px] pr-6 text-left transition-[background-color] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_SEARCH_RESULT_TITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-base [font-weight:530]"
const HOME_SEARCH_RESULT_META =
  "min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]"

let pendingHomeNavigation: { server: ServerConnection.Key; href: string } | undefined

function matchesHomeSessionSearch(record: HomeSessionRecord, query: string) {
  return `${record.session.title} ${record.projectName}`.toLowerCase().includes(query)
}

function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function useHomeSessionHeaderOpacity(groups: () => HomeSessionGroup[]) {
  let viewport: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let positionFrame: number | undefined
  let resizeObserver: ResizeObserver | undefined
  let stickyTop = HOME_SESSION_HEADER_STICKY_TOP
  const headerRefs = new Map<HomeSessionGroup["id"], HTMLDivElement>()
  const headerOffsets = new Map<HomeSessionGroup["id"], number>()
  const [state, setState] = createStore({
    titleOpacity: {} as Partial<Record<HomeSessionGroup["id"], number>>,
  })

  createEffect(() => {
    const items = groups()
    const ids = new Set(items.map((group) => group.id))
    headerRefs.forEach((_, id) => {
      if (!ids.has(id)) headerRefs.delete(id)
    })
    headerOffsets.forEach((_, id) => {
      if (!ids.has(id)) headerOffsets.delete(id)
    })
    if (items.length === 0) {
      content = undefined
      bindResizeObserver()
    }
    queuePositionUpdate()
  })

  onCleanup(() => {
    if (positionFrame !== undefined) cancelAnimationFrame(positionFrame)
    resizeObserver?.disconnect()
  })

  function setViewport(el: HTMLDivElement) {
    viewport = el
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setContentRef(el: HTMLDivElement) {
    content = el
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setHeaderRef(id: HomeSessionGroup["id"], el: HTMLDivElement) {
    headerRefs.set(id, el)
    queuePositionUpdate()
  }

  function queuePositionUpdate() {
    if (typeof requestAnimationFrame === "undefined") {
      updatePositionCache()
      return
    }
    if (positionFrame !== undefined) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined
      updatePositionCache()
    })
  }

  function updatePositionCache() {
    if (!viewport) return
    const header = groups()
      .map((group) => headerRefs.get(group.id))
      .find((el) => el !== undefined)
    if (header && typeof getComputedStyle === "function") {
      const top = Number.parseFloat(getComputedStyle(header).top)
      if (Number.isFinite(top)) stickyTop = top
    }
    groups().forEach((group) => {
      const el = headerRefs.get(group.id)
      if (!el) return
      headerOffsets.set(group.id, el.offsetTop)
    })
    update(viewport.scrollTop)
  }

  function update(scrollTop: number) {
    const items = groups()
    items.forEach((group, index) => {
      const nextOffset = items
        .slice(index + 1)
        .map((item) => headerOffsets.get(item.id))
        .find((offset) => offset !== undefined)
      const fadeEnd = stickyTop + HOME_SESSION_HEADER_TEXT_HEIGHT
      const nextTop = nextOffset === undefined ? undefined : nextOffset - scrollTop
      const opacity =
        nextTop === undefined ? 1 : Math.max(0, Math.min(1, (nextTop - fadeEnd) / HOME_SESSION_HEADER_FADE_DISTANCE))
      setState("titleOpacity", group.id, Math.round(opacity * 1000) / 1000)
    })
  }

  function titleOpacity(id: HomeSessionGroup["id"]) {
    return state.titleOpacity[id] ?? 1
  }

  function bindResizeObserver() {
    resizeObserver?.disconnect()
    if (typeof ResizeObserver === "undefined") return
    resizeObserver = new ResizeObserver(() => queuePositionUpdate())
    if (viewport) resizeObserver.observe(viewport)
    if (content) resizeObserver.observe(content)
  }

  return { setViewport, setContentRef, setHeaderRef, update, titleOpacity }
}

// Middle-click or Cmd+click on macOS (Ctrl+click elsewhere) opens a session
// tab in the background without navigating, matching browser conventions.
function isBackgroundOpen(event: MouseEvent) {
  return shouldOpenSessionInBackground({
    button: event.button,
    mac: typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

export function NewHome() {
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const global = useGlobal()
  const tabs = useTabs()
  const command = useCommand()
  const marked = useMarked()
  // Shared Agents-panel state (components/agents-panel-state.tsx): the shell
  // renders the desktop panel on every Agents-surface route, so selection,
  // records, and open/create actions live in that provider. Home consumes the
  // same context for its stacked column and session list.
  const panel = useAgentsPanel()
  useSettingsCommand()
  let focusSessionSearch: (() => void) | undefined
  let sessionViewport: HTMLDivElement | undefined
  const [sessionThumbTrack, setSessionThumbTrack] = createSignal<HTMLDivElement>()
  const [sessionHoverTarget, setSessionHoverTarget] = createSignal<HTMLElement>()
  const [state, setState] = createStore({
    search: "",
    searchFocused: false,
  })
  const selection = panel.selection
  const focusedServer = panel.focusedServer
  const focusedServerCtx = panel.focusedServerCtx
  const selectedProject = panel.selectedProject
  const newSessionProject = panel.newSessionProject
  const allRecords = panel.allRecords
  const records = panel.records
  const searchSessions = panel.searchSessions
  const openSession = panel.openSession
  const openNewSession = panel.openNewSession
  const search = createMemo(() => state.search.trim())
  const searchPlaceholder = createMemo(() => {
    const project = selectedProject()
    if (project) {
      return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })
    }
    if (global.servers.list().length > 1) {
      const conn = focusedServer()
      if (conn) {
        return language.t("home.sessions.search.placeholder.scoped", { scope: serverName(conn) })
      }
    }
    return language.t("home.sessions.search.placeholder")
  })
  const [searchResults, setSearchResults] = createSignal<HomeSessionRecord[]>([])
  let searchRevision = 0
  let searchAbort: AbortController | undefined
  createEffect(() => {
    const query = search().toLowerCase()
    const revision = ++searchRevision
    searchAbort?.abort()
    if (!query) {
      setSearchResults([])
      return
    }
    searchAbort = new AbortController()
    const local = allRecords().filter((record) => matchesHomeSessionSearch(record, query))
    setSearchResults(local)
    void searchSessions(query, searchAbort.signal)
      .then((remote) => {
        if (revision !== searchRevision) return
        const merged = new Map(local.map((record) => [record.session.id, record] as const))
        remote.forEach((record) => merged.set(record.session.id, record))
        setSearchResults([...merged.values()])
      })
      .catch(() => {})
  })
  onCleanup(() => searchAbort?.abort())
  const searchOpen = createMemo(() => state.searchFocused && search().length > 0)
  const groups = createMemo(() => groupSessions(records(), language))
  const sessionHeaderOpacity = useHomeSessionHeaderOpacity(groups)
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = focusedServerCtx()
    if (!ctx) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(focusedServer()!)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() => {
                return Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id, marked)
                    }),
                  ),
                )
              })
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  function closeSearch() {
    setState("search", "")
    setState("searchFocused", false)
  }

  // The panel's search action works from every route (components/agents-panel-
  // state.tsx navigates home first when needed); home owns the input, so it
  // binds the actual focus function while mounted.
  panel.bindSearchFocus(() => focusSessionSearch?.())
  onCleanup(() => panel.bindSearchFocus(undefined))

  function selectSearchSession(session: Session, options?: OpenSessionOptions) {
    openSession(session, options)
    // Background opens keep the search visible so several results can be
    // opened in a row.
    if (!options?.background) closeSearch()
  }

  useCommandPalette(() => {
    void (async () => {
      const conn = focusedServer()
      if (!conn) return
      const ctx = global.ensureServerCtx(conn)
      const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
      void dialog.show(() => (
        <DialogHomeCommandPaletteV2
          server={conn}
          onSelectSession={(entry) => {
            if (!entry.sessionID || !entry.directory || !entry.server) return
            const sessionID = entry.sessionID
            const server = entry.server
            const directory = entry.project?.worktree ?? entry.directory
            ctx.projects.open(directory)
            ctx.projects.touch(directory)
            const tab = tabs.addSessionTab({ server, sessionId: sessionID })
            tabs.select(tab)
          }}
        />
      ))
    })()
  })

  command.register("home", () => [
    {
      id: "home.sessions.search.focus",
      title: searchPlaceholder(),
      keybind: "mod+f",
      hidden: true,
      onSelect: () => focusSessionSearch?.(),
    },
  ])

  createEffect(() => {
    const pending = pendingHomeNavigation
    if (!pending || pending.server !== server.key) return
    pendingHomeNavigation = undefined
    navigate(pending.href)
  })

  async function archiveSession(session: Session) {
    const conn = focusedServer()
    const ctx = focusedServerCtx()
    if (!conn || !ctx) return
    const [, setStore] = ctx.sync.child(session.directory)
    await archiveHomeSession({
      server: ServerConnection.key(conn),
      session,
      update: (value) => ctx.sdk.client.session.update(value),
      remove: (update) => {
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, session.id, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
        // The left nav renders from the home session index, not the child
        // store above - apply the archive there too so the row disappears even
        // when the server's session.updated event is missed.
        ctx.sync.homeSessions.apply(archivedHomeSessionEvent(session, update.time.archived))
      },
      onError: (error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
    })
  }

  return (
    <main
      data-component="home-page"
      class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
    >
      <PageHeader title="Agents" description="Manage projects, sessions, and agent work." />
      <div class="m-2 flex min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
        {/* The desktop Agents panel is shell chrome now — pages/layout-new.tsx
            mounts it (components/agents-panel.tsx) so it persists across
            session routes; home only renders the stacked narrow
            variant below. */}
        <ScrollView
          class="h-full min-w-0 flex-1 [container-type:size]"
          thumbContainer={sessionThumbTrack}
          thumbHoverTarget={sessionHoverTarget}
          viewportRef={(el) => {
            sessionViewport = el
            sessionHeaderOpacity.setViewport(el)
          }}
          onScroll={(event) => sessionHeaderOpacity.update(event.currentTarget.scrollTop)}
          onWheel={(event) => {
            if (!sessionViewport) return
            if (event.target instanceof Node && sessionViewport.contains(event.target)) return
            containHomeWheel(event, sessionViewport)
          }}
        >
          <div class="mx-auto grid min-h-full w-full max-w-[780px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3 lg:grid-rows-1 lg:px-7 xl:px-10">
            <AgentsProjectColumn
              desktop={false}
              onWheel={(event) => {
                if (sessionViewport) containHomeWheel(event, sessionViewport)
              }}
            />

            <section
              ref={setSessionHoverTarget}
              class="min-h-0 min-w-0 flex flex-1 flex-col"
              aria-label={language.t("sidebar.project.recentSessions")}
            >
              <div
                class="sticky top-0 z-30 shrink-0 bg-v2-background-bg-base pb-3 pt-6 lg:pt-12"
                onWheel={(event) => {
                  if (sessionViewport) containHomeWheel(event, sessionViewport)
                }}
              >
                <div class="flex min-w-0 items-center gap-2">
                  <HomeSessionSearch
                    value={state.search}
                    placeholder={searchPlaceholder()}
                    open={searchOpen()}
                    loading={panel.sessionsLoading()}
                    results={searchResults()}
                    showProjectName={!selectedProject()}
                    server={selection().server}
                    noResultsLabel={language.t("home.sessions.search.noResults", { query: search() })}
                    bindFocus={(focus) => {
                      focusSessionSearch = focus
                    }}
                    onInput={(value) => setState("search", value)}
                    onFocus={() => setState("searchFocused", true)}
                    onClose={closeSearch}
                    onSelect={selectSearchSession}
                  />
                </div>
                <Show when={groups().length > 0 && newSessionProject()}>
                  <div class="pointer-events-none absolute right-0 top-[84px] z-20 flex lg:hidden">
                    <ButtonV2
                      data-action="home-new-session"
                      variant="ghost-muted"
                      size="normal"
                      icon="edit"
                      class="pointer-events-auto h-7 px-2 [font-weight:530]"
                      onClick={openNewSession}
                    >
                      {language.t("command.session.new")}
                    </ButtonV2>
                  </div>
                </Show>
              </div>
              {/* Sticky chrome for the portaled session scrollbar — matches old sessions ScrollView bounds */}
              <div class="pointer-events-none sticky top-[84px] z-40 -mr-3 h-0 lg:top-[108px]">
                <div
                  ref={setSessionThumbTrack}
                  data-component="home-session-scroll-track"
                  class="relative ml-auto h-[calc(100cqh-84px)] w-3 lg:h-[calc(100cqh-108px)]"
                />
              </div>
              <div class="-mr-3 min-h-[calc(100cqh-72px)] lg:min-h-[calc(100cqh-96px)]">
                <Show
                  when={!panel.sessionsLoading()}
                  fallback={
                    <div class="pt-3">
                      <HomeSessionSkeleton label={language.t("common.loading")} />
                    </div>
                  }
                >
                  <Show
                    when={groups().length > 0}
                    fallback={<HomeSessionsEmpty onNewSession={newSessionProject() ? openNewSession : undefined} />}
                  >
                    <div ref={sessionHeaderOpacity.setContentRef} class="flex flex-col pb-16 pr-3 pt-3">
                      <LatestAutomationRuns layout="home" />
                      <For each={groups()}>
                        {(group, index) => (
                          <>
                            <HomeSessionGroupHeader
                              title={group.title}
                              titleOpacity={sessionHeaderOpacity.titleOpacity(group.id)}
                              ref={(el) => sessionHeaderOpacity.setHeaderRef(group.id, el)}
                              elevated={index() === 0}
                            />
                            <div
                              class={`flex min-w-0 flex-col gap-px pt-4 ${index() === groups().length - 1 ? "" : "mb-6"}`}
                            >
                              <For each={group.sessions}>
                                {(record) => (
                                  <HomeSessionRow
                                    record={record}
                                    showProjectName={!selectedProject()}
                                    server={selection().server}
                                    openSession={openSession}
                                    archiveSession={archiveSession}
                                  />
                                )}
                              </For>
                            </div>
                          </>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </section>
          </div>
        </ScrollView>
      </div>
    </main>
  )
}

// The Agents panel: one component, two mounts. The desktop variant is shell
// chrome (components/agents-panel.tsx renders it from pages/layout-new.tsx on
// every Agents-surface route); the stacked variant renders inline on the
// narrow home layout. Both read the same AgentsPanel context, so selection,
// records, and actions stay one state across routes.
export function AgentsProjectColumn(props: { desktop: boolean; onWheel?: (event: WheelEvent) => void }) {
  const panel = useAgentsPanel()
  const language = useLanguage()

  return (
    <HomeProjectColumn
      desktop={props.desktop}
      projects={panel.projects()}
      records={panel.records()}
      focusRecords={panel.focusRecords()}
      focusedServer={panel.focusedServer}
      recentlyClosed={panel.recentlyClosed()}
      homedir={panel.homedir()}
      selected={panel.selection()}
      canCreateNewSession={panel.canOpenNewSession()}
      focusServer={panel.focusServer}
      focusSearch={panel.focusSearch}
      createNewSession={panel.openNewSession}
      selectProject={panel.selectProject}
      openSession={panel.openSession}
      openNewSession={panel.openProjectNewSession}
      openRecentProject={(conn, directory) => panel.addProjects(conn, [directory])}
      chooseProject={(conn) => panel.chooseProject(conn)}
      editProject={panel.editProject}
      closeProject={panel.closeProject}
      clearNotifications={panel.clearNotifications}
      unseenCount={panel.unseenCount}
      renameSession={panel.renameSession}
      archiveSession={panel.archiveSession}
      pinnedRecords={panel.pinnedRecords()}
      isSessionPinned={panel.isSessionPinned}
      pinSession={panel.pinSession}
      unpinSession={panel.unpinSession}
      restoreSession={panel.restoreSession}
      deleteSession={panel.deleteSession}
      inactiveOpen={panel.inactiveOpen()}
      toggleInactive={panel.toggleInactive}
      inactiveSessions={panel.inactiveSessions()}
      inactiveLoading={panel.inactiveLoading()}
      inactiveFailed={panel.inactiveFailed()}
      archivedOpen={panel.archivedOpen()}
      toggleArchived={panel.toggleArchived}
      archivedSessions={panel.archivedSessions()}
      archivedLoading={panel.archivedLoading()}
      archivedFailed={panel.archivedFailed()}
      language={language}
      onWheel={(event) => props.onWheel?.(event)}
    />
  )
}

function HomeProjectColumn(props: {
  desktop: boolean
  projects: LocalProject[]
  records: HomeSessionRecord[]
  focusRecords: HomeSessionRecord[]
  focusedServer: () => ServerConnection.Any | undefined
  recentlyClosed: LocalProject[]
  homedir: string
  selected: HomeProjectSelection
  canCreateNewSession: boolean
  focusServer: (server: ServerConnection.Any) => void
  focusSearch: () => void
  createNewSession: () => void
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openSession: (session: Session, options?: OpenSessionOptions) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  openRecentProject: (server: ServerConnection.Any, directory: string) => void
  chooseProject: (server: ServerConnection.Any) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  renameSession: (session: Session) => void
  archiveSession: (session: Session) => void
  pinnedRecords: HomeSessionRecord[]
  isSessionPinned: (session: Session) => boolean
  pinSession: (session: Session) => void
  unpinSession: (session: Session) => void
  restoreSession: (session: Session) => void
  deleteSession: (session: Session) => void
  inactiveOpen: boolean
  toggleInactive: () => void
  inactiveSessions: Session[]
  inactiveLoading: boolean
  inactiveFailed: boolean
  archivedOpen: boolean
  toggleArchived: () => void
  archivedSessions: Session[]
  archivedLoading: boolean
  archivedFailed: boolean
  language: ReturnType<typeof useLanguage>
  onWheel: (event: WheelEvent) => void
}) {
  const global = useGlobal()
  const notification = useNotification()
  const permission = usePermission()
  const [library, setLibrary] = createStore({ filter: "all" as "all" | "running" | "archived" })
  const selectedServer = () =>
    props.focusedServer() ??
    global.servers.list().find((item) => ServerConnection.key(item) === props.selected.server) ??
    global.servers.list()[0]

  const sessionStatus = (server: ServerConnection.Any | undefined, session: Session) => {
    if (!server || global.servers.health[ServerConnection.key(server)]?.healthy !== true) return "settled" as const

    const serverKey = ServerConnection.key(server)
    const serverSync = global.ensureServerCtx(server).sync
    const [directoryStore] = serverSync.child(session.directory, { bootstrap: false })
    const permissionState = permission.ensureServerState(serverKey)
    const hasPermission = !!sessionPermissionRequest(
      directoryStore.session,
      serverSync.session.data.permission,
      session.id,
      (item) => !permissionState?.autoResponds(item, session.directory),
    )
    const hasQuestion = !!sessionQuestionRequest(directoryStore.session, serverSync.session.data.question, session.id)
    const serverNotifications = notification.ensureServerState(serverKey)

    return sessionNavStatus({
      hasPermission,
      hasQuestion,
      hasError: serverNotifications?.session.unseenHasError(session.id) ?? false,
      working: serverSync.session.data.session_working(session.id),
      loading: directoryStore.status !== "complete",
      unreadCount: serverNotifications?.session.unseenCount(session.id) ?? 0,
    })
  }

  // The home index provides summaries only. Hydrate only the bounded focus and
  // visible row directories so a passive session can promote itself safely.
  const directoryHydration = createMemo(
    () => {
      const server = selectedServer()
      if (!server || global.servers.health[ServerConnection.key(server)]?.healthy !== true) return
      const directories = directoryHydrationPlan({
        focus: props.focusRecords.map((record) => record.session.directory),
        pinned: props.pinnedRecords.map((record) => record.session.directory),
        recent: props.records.map((record) => record.session.directory),
      })
      const serverSync = global.ensureServerCtx(server).sync
      return { key: directoryHydrationKey(ServerConnection.key(server), directories), serverSync, directories }
    },
    undefined,
    { equals: (previous, next) => previous?.key === next?.key && previous?.serverSync === next?.serverSync },
  )

  createEffect(
    on(directoryHydration, (target) => {
      if (!target) return
      void target.serverSync.hydrateDirectories(target.directories)
    }),
  )

  const selectedSessionStatus = (session: Session) => sessionStatus(selectedServer(), session)
  const selectedProject = createMemo(() => {
    const directory = props.selected.directory
    if (!directory) return undefined
    const key = pathKey(directory)
    return props.projects.find((project) => pathKey(project.worktree) === key)
  })
  const knownDirectories = createMemo(
    () => new Set(props.projects.flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])]).map(pathKey)),
  )
  const runningRecords = createMemo(() =>
    props.records.filter((record) => {
      const status = selectedSessionStatus(record.session)
      return status === "working" || status === "attention"
    }),
  )
  const libraryRecords = createMemo(() =>
    recentHomeSessionRecords(library.filter === "running" ? runningRecords() : props.records, props.records.length),
  )
  const archivedSessions = createMemo(() =>
    props.archivedSessions.filter((session) => knownDirectories().has(pathKey(session.directory))),
  )
  const inactiveSessions = createMemo(() =>
    props.inactiveSessions.filter((session) => knownDirectories().has(pathKey(session.directory))),
  )
  const libraryGroups = createMemo(() => groupSessions(libraryRecords(), props.language))

  function setLibraryFilter(filter: "all" | "running" | "archived") {
    if (filter === "archived" && !props.archivedOpen) props.toggleArchived()
    if (library.filter === "archived" && filter !== "archived" && props.archivedOpen) props.toggleArchived()
    setLibrary("filter", filter)
  }

  // archivedOpen is keyed on the selection, so it drops when the project chip
  // changes; re-arm it while the Archived filter stays active.
  createEffect(() => {
    if (library.filter === "archived" && !props.archivedOpen) props.toggleArchived()
  })

  const inbox = () => (
    <Show when={props.focusRecords.length > 0}>
      <div data-component="home-inbox" class="mt-4 flex min-w-0 shrink-0 flex-col px-2">
        <div class="flex h-7 shrink-0 items-center justify-between px-2 text-[10px] uppercase tracking-[0.08em] text-v2-text-text-faint [font-weight:600]">
          <span>Active</span>
          <span class="tabular-nums">{props.focusRecords.length}</span>
        </div>
        <div class="flex min-w-0 flex-col gap-1">
          <For each={props.focusRecords}>
            {(record) => (
              <HomeInboxRow
                record={record}
                status={() => selectedSessionStatus(record.session)}
                openSession={props.openSession}
                renameSession={props.renameSession}
                archiveSession={props.archiveSession}
                deleteSession={props.deleteSession}
                pinned={props.isSessionPinned(record.session)}
                pinSession={props.pinSession}
                unpinSession={props.unpinSession}
                language={props.language}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  )

  const pinned = () => (
    <Show when={props.pinnedRecords.length > 0}>
      <div data-component="home-pinned-sessions" class="mt-4 flex max-h-[40%] min-w-0 shrink-0 flex-col px-2">
        <div class="flex h-7 shrink-0 items-center px-2 text-[11px] uppercase tracking-[0.08em] text-v2-text-text-faint [font-weight:600]">
          {props.language.t("home.pinnedSessions")}
        </div>
        <div class="flex min-w-0 flex-col gap-0.5 overflow-y-auto no-scrollbar">
          <For each={props.pinnedRecords}>
            {(record) => (
              <HomeNavSessionRow
                session={record.session}
                status={() => selectedSessionStatus(record.session)}
                working={() =>
                  selectedServer()
                    ? global.ensureServerCtx(selectedServer()!).sync.session.data.session_working(record.session.id)
                    : false
                }
                openSession={props.openSession}
                renameSession={props.renameSession}
                archiveSession={props.archiveSession}
                deleteSession={props.deleteSession}
                pinned
                unpinSession={props.unpinSession}
                language={props.language}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  )

  const projectPickerItems = (conn: ServerConnection.Any) => (
    <>
      <MenuV2.Item
        data-action="home-library-all-projects"
        badge={selectedProject() ? undefined : <IconV2 name="check" size="small" />}
        onSelect={() => props.focusServer(conn)}
      >
        All projects
      </MenuV2.Item>
      <For each={props.projects}>
        {(project) => {
          const current = () => selectedProject() === project
          const unseen = () => props.unseenCount(conn, project)
          return (
            <MenuV2.Item
              data-action="home-library-project"
              badge={current() ? <IconV2 name="check" size="small" /> : unseen() > 0 ? unseen() : undefined}
              onSelect={() => props.selectProject(conn, project.worktree)}
            >
              <span class="flex min-w-0 items-center gap-2">
                <HomeProjectAvatar project={project} />
                <span class="min-w-0 truncate">{displayName(project)}</span>
              </span>
            </MenuV2.Item>
          )
        }}
      </For>
      <MenuV2.Separator />
      <MenuV2.Item data-action="home-add-project" onSelect={() => props.chooseProject(conn)}>
        {props.language.t("home.project.add")}
      </MenuV2.Item>
    </>
  )

  const projectActionsGroup = (conn: ServerConnection.Any, project: LocalProject) => (
    <MenuV2.Group>
      <MenuV2.GroupLabel>{displayName(project)}</MenuV2.GroupLabel>
      <HomeProjectMenuItems
        project={project}
        server={conn}
        unseenCount={props.unseenCount(conn, project)}
        openNewSession={props.openNewSession}
        editProject={props.editProject}
        closeProject={props.closeProject}
        clearNotifications={props.clearNotifications}
        language={props.language}
      />
    </MenuV2.Group>
  )

  // The project selector sits on the library header on desktop. The stacked
  // variant has no header, so it keeps a combined project chip in the chip row.
  const projectSelector = (conn: ServerConnection.Any) => (
    <MenuV2 gutter={6} modal={false} placement="bottom-end">
      <MenuV2.Trigger
        type="button"
        data-component="home-library-project-chip"
        class="flex h-5 min-w-0 max-w-[130px] items-center gap-0.5 rounded-[4px] px-1 text-[11px] text-v2-text-text-faint [font-weight:600] transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted"
      >
        <span class="min-w-0 truncate">{selectedProject() ? displayName(selectedProject()!) : "All projects"}</span>
        <IconV2 name="chevron-down" size="small" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>{projectPickerItems(conn)}</MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )

  const chips = () => {
    return (
      <div class="flex min-w-0 items-center gap-1 px-2">
        <Show when={props.desktop}>
          <button
            type="button"
            data-component="home-library-filter"
            data-value="all"
            data-active={library.filter === "all" ? "" : undefined}
            class={HOME_LIBRARY_CHIP}
            onClick={() => setLibraryFilter("all")}
          >
            All <span class="tabular-nums text-v2-text-text-faint">{props.records.length}</span>
          </button>
          <button
            type="button"
            data-component="home-library-filter"
            data-value="running"
            data-active={library.filter === "running" ? "" : undefined}
            class={HOME_LIBRARY_CHIP}
            onClick={() => setLibraryFilter("running")}
          >
            Running <span class="tabular-nums text-v2-text-text-faint">{runningRecords().length}</span>
          </button>
          <button
            type="button"
            data-component="home-library-filter"
            data-value="archived"
            data-active={library.filter === "archived" ? "" : undefined}
            class={HOME_LIBRARY_CHIP}
            onClick={() => setLibraryFilter("archived")}
          >
            {props.language.t("session.archived.show")}
          </button>
        </Show>
        <Show when={!props.desktop && selectedServer()}>
          {(conn) => (
            <MenuV2 gutter={6} modal={false} placement="bottom-start">
              <MenuV2.Trigger
                type="button"
                data-component="home-library-project-chip"
                data-active={selectedProject() ? "" : undefined}
                class={`${HOME_LIBRARY_CHIP} min-w-0 max-w-[120px] shrink`}
              >
                <span class="min-w-0 truncate">
                  {selectedProject() ? displayName(selectedProject()!) : "All projects"}
                </span>
                <IconV2 name="chevron-down" size="small" />
              </MenuV2.Trigger>
              <MenuV2.Portal>
                <MenuV2.Content>
                  {projectPickerItems(conn())}
                  <Show when={selectedProject()}>
                    {(project) => (
                      <>
                        <MenuV2.Separator />
                        {projectActionsGroup(conn(), project())}
                      </>
                    )}
                  </Show>
                </MenuV2.Content>
              </MenuV2.Portal>
            </MenuV2>
          )}
        </Show>
        <Show when={global.servers.list().length > 1 && selectedServer()}>
          {(conn) => (
            <MenuV2 gutter={6} modal={false} placement="bottom-start">
              <MenuV2.Trigger
                type="button"
                data-component="home-library-server-chip"
                class={`${HOME_LIBRARY_CHIP} max-w-[140px]`}
              >
                <span class="min-w-0 truncate">{conn().displayName ?? new URL(conn().http.url).host}</span>
                <IconV2 name="chevron-down" size="small" />
              </MenuV2.Trigger>
              <MenuV2.Portal>
                <MenuV2.Content>
                  <For each={global.servers.list()}>
                    {(item) => {
                      const healthy = () => global.servers.health[ServerConnection.key(item)]?.healthy === true
                      return (
                        <MenuV2.Item
                          data-action="home-library-server"
                          disabled={!healthy()}
                          onSelect={() => props.focusServer(item)}
                        >
                          <span class="flex min-w-0 items-center gap-2">
                            <ServerHealthIndicator health={global.servers.health[ServerConnection.key(item)]} />
                            <span class="min-w-0 truncate">{item.displayName ?? new URL(item.http.url).host}</span>
                          </span>
                        </MenuV2.Item>
                      )
                    }}
                  </For>
                </MenuV2.Content>
              </MenuV2.Portal>
            </MenuV2>
          )}
        </Show>
      </div>
    )
  }

  const libraryList = () => (
    <Show
      when={props.projects.length > 0}
      fallback={
        <div class="px-2">
          <Show when={selectedServer()}>
            {(server) => (
              <HomeProjectEmpty
                server={server()}
                recentlyClosed={props.recentlyClosed}
                homedir={props.homedir}
                chooseProject={props.chooseProject}
                openRecentProject={props.openRecentProject}
                language={props.language}
              />
            )}
          </Show>
        </div>
      }
    >
      <Switch>
        <Match when={library.filter === "archived"}>
          <div class="flex min-w-0 flex-col">
            <Show when={props.archivedFailed}>
              <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-danger">
                {props.language.t("session.archived.failed")}
              </p>
            </Show>
            <Show when={!props.archivedFailed && props.archivedLoading && archivedSessions().length === 0}>
              <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-faint">
                {props.language.t("common.loading")}
              </p>
            </Show>
            <Show when={!props.archivedFailed && !props.archivedLoading && archivedSessions().length === 0}>
              <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-faint">
                {props.language.t("session.archived.empty")}
              </p>
            </Show>
            <For each={archivedSessions()}>
              {(session) => (
                <HomeNavSessionRow
                  session={session}
                  openSession={props.openSession}
                  restoreSession={props.restoreSession}
                  deleteSession={props.deleteSession}
                  language={props.language}
                />
              )}
            </For>
          </div>
        </Match>
        <Match when={true}>
          <Show
            when={libraryGroups().length > 0}
            fallback={
              <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-faint">
                {props.language.t("home.sessions.empty")}
              </p>
            }
          >
            <For each={libraryGroups()}>
              {(group) => (
                <>
                  <div class="px-2 pb-1 pt-3 text-[10.5px] [font-weight:600] text-v2-text-text-faint">
                    {group.title}
                  </div>
                  <For each={group.sessions}>
                    {(record) => (
                      <HomeNavSessionRow
                        session={record.session}
                        projectName={selectedProject() ? undefined : record.projectName}
                        status={() => selectedSessionStatus(record.session)}
                        openSession={props.openSession}
                        renameSession={props.renameSession}
                        archiveSession={props.archiveSession}
                        deleteSession={props.deleteSession}
                        pinned={props.isSessionPinned(record.session)}
                        pinSession={props.pinSession}
                        unpinSession={props.unpinSession}
                        language={props.language}
                      />
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
          <Show when={library.filter === "all"}>
            <button
              type="button"
              data-component="home-library-older-toggle"
              aria-expanded={props.inactiveOpen}
              class={`${HOME_PROJECT_NAV_ROW} mt-1 h-7 px-1.5 text-v2-text-text-faint`}
              onClick={() => props.toggleInactive()}
            >
              <span class={HOME_PROJECT_NAV_LABEL}>
                {props.language.t(props.inactiveOpen ? "home.library.olderHide" : "home.library.older")}
              </span>
            </button>
            <Show when={props.inactiveOpen}>
              <div class="px-2 pb-1 pt-3 text-[10.5px] [font-weight:600] text-v2-text-text-faint">
                {props.language.t("home.sessions.group.older")}
              </div>
              <Show when={props.inactiveFailed}>
                <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-danger">
                  {props.language.t("session.inactive.failed")}
                </p>
              </Show>
              <Show when={!props.inactiveFailed && props.inactiveLoading && inactiveSessions().length === 0}>
                <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-faint">
                  {props.language.t("common.loading")}
                </p>
              </Show>
              <Show when={!props.inactiveFailed && !props.inactiveLoading && inactiveSessions().length === 0}>
                <p class="px-1.5 py-1 text-[11px] font-[440] text-v2-text-text-faint">
                  {props.language.t("session.inactive.empty")}
                </p>
              </Show>
              <For each={inactiveSessions()}>
                {(session) => (
                  <HomeNavSessionRow
                    session={session}
                    openSession={props.openSession}
                    renameSession={props.renameSession}
                    archiveSession={props.archiveSession}
                    deleteSession={props.deleteSession}
                    pinned={props.isSessionPinned(session)}
                    pinSession={props.pinSession}
                    unpinSession={props.unpinSession}
                    language={props.language}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Match>
      </Switch>
    </Show>
  )

  if (props.desktop) {
    // Settings, Help, and the server affordance live in the rail; this panel
    // keeps the Agents world — new session, search, projects, sessions.
    const navRail = useNavRail()
    const collapsed = () => navRail.collapsed("agents")

    return (
      <aside
        data-component="home-left-nav"
        data-collapsed={collapsed() ? "" : undefined}
        class="hidden h-full shrink-0 flex-col overflow-hidden border-v2-border-border-base bg-v2-background-bg-layer-01 transition-[width] duration-[180ms] ease-in-out motion-reduce:transition-none lg:flex"
        classList={{ "border-r": !collapsed() }}
        style={{ width: collapsed() ? "0px" : "264px" }}
        aria-label="TurenOS"
        aria-hidden={collapsed() || undefined}
        inert={collapsed() || undefined}
      >
        <div class="flex h-full w-[264px] shrink-0 flex-col">
          <nav
            class="flex shrink-0 flex-col gap-1 px-2 pt-2"
            aria-label={props.language.t("sidebar.nav.projectsAndSessions")}
          >
            <button
              type="button"
              data-action="home-new-session"
              class={`${HOME_LEFT_NAV_ACTION} bg-v2-background-bg-layer-02 [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`}
              onClick={props.createNewSession}
              disabled={!props.canCreateNewSession}
            >
              <IconV2 name="edit" size="small" />
              <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("command.session.new")}</span>
            </button>
            <button
              type="button"
              data-action="home-focus-search"
              class={HOME_LEFT_NAV_ACTION}
              onClick={props.focusSearch}
            >
              <IconV2 name="magnifying-glass" size="small" />
              <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("common.search.placeholder")}</span>
            </button>
          </nav>

          {inbox()}

          {pinned()}

          <div class="mt-5 flex min-h-0 flex-1 flex-col">
            <div class="flex h-7 shrink-0 items-center justify-between gap-1 px-2 text-[11px] uppercase tracking-[0.08em] text-v2-text-text-faint [font-weight:600]">
              {props.language.t("home.library")}
              <Show when={props.projects.length > 0 ? selectedServer() : undefined}>
                {(conn) => (
                  <span class="flex min-w-0 items-center normal-case tracking-normal">
                    {projectSelector(conn())}
                    <Show when={selectedProject()}>
                      {(project) => (
                        <MenuV2 gutter={6} modal={false} placement="bottom-end">
                          <MenuV2.Trigger
                            as={IconButtonV2}
                            data-action="home-library-project-menu"
                            variant="ghost-muted"
                            size="small"
                            icon={<IconV2 name="outline-dots" />}
                            aria-label={props.language.t("common.moreOptions")}
                          />
                          <MenuV2.Portal>
                            <MenuV2.Content>{projectActionsGroup(conn(), project())}</MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      )}
                    </Show>
                  </span>
                )}
              </Show>
            </div>
            <Show when={props.projects.length > 0}>
              <div class="mt-1">{chips()}</div>
            </Show>
            <ScrollView data-slot="home-projects-scroll" class="mt-1 min-h-0 min-w-0 flex-1">
              {libraryList()}
            </ScrollView>
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside
      class="mt-6 flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden lg:hidden"
      aria-label={props.language.t("home.library")}
      onWheel={(event) => {
        if (event.target === event.currentTarget) return
        props.onWheel(event)
      }}
    >
      {inbox()}
      {pinned()}
      {chips()}
    </aside>
  )
}

// The row is a button plus a sibling hover-reveal menu. The menu cannot nest inside the button (invalid, and the
// trigger's click would open the session), so both live in a `group/session` wrapper and the button reserves
// right padding for the cluster.
function HomeNavSessionRow(props: {
  session: Session
  projectName?: string
  source?: string
  status?: () => SessionNavStatus
  working?: () => boolean
  openSession: (session: Session, options?: OpenSessionOptions) => void
  language: ReturnType<typeof useLanguage>
  renameSession?: (session: Session) => void
  archiveSession?: (session: Session) => void
  pinned?: boolean
  pinSession?: (session: Session) => void
  unpinSession?: (session: Session) => void
  restoreSession?: (session: Session) => void
  deleteSession?: (session: Session) => void
}) {
  const layout = useLayout()
  const [state, setState] = createStore({ menuOpen: false })
  let row: HTMLDivElement | undefined
  // The session's open tab drives the highlight: AgentsPanelProvider selects
  // the project when a session tab activates, this row marks itself current.
  const active = createMemo(() => {
    const route = layout.route()
    return route.type === "session" && route.sessionId === props.session.id
  })
  createEffect(() => {
    if (!active()) return
    row?.scrollIntoView({ block: "nearest" })
  })
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)
  const status = createMemo(() => props.status?.() ?? (props.working?.() ? "working" : "settled"))
  const accessibleLabel = createMemo(() =>
    [title(), props.source, props.projectName, sessionNavStatusLabel(status())].filter(Boolean).join(" - "),
  )
  return (
    <div
      ref={(el) => {
        row = el
      }}
      class="group/session relative flex h-7 min-w-0 items-center rounded-[6px]"
    >
      <button
        type="button"
        data-component="home-nav-session-row"
        data-status={status()}
        data-active={active() ? "" : undefined}
        aria-current={active() ? "page" : undefined}
        class={`${HOME_PROJECT_NAV_ROW} group h-7 px-1.5 pr-8 text-v2-text-text-faint data-[active]:bg-v2-background-bg-layer-03 data-[active]:text-v2-text-text-base data-[active]:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`}
        title={accessibleLabel()}
        aria-label={accessibleLabel()}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onClick={(event) => props.openSession(props.session, { background: isBackgroundOpen(event) })}
        onAuxClick={(event) => {
          if (!isBackgroundOpen(event)) return
          event.preventDefault()
          props.openSession(props.session, { background: true })
        }}
      >
        <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted" aria-hidden="true">
          <HomeSessionStatusGlyph status={status()} />
        </span>
        <span class={HOME_PROJECT_NAV_LABEL}>{title()}</span>
        <Show when={props.source}>
          {(source) => (
            <span class="min-w-0 max-w-[32%] shrink-0 truncate text-[10px] text-v2-text-text-faint">{source()}</span>
          )}
        </Show>
        <Show when={props.projectName}>
          {(projectName) => (
            <span class="min-w-0 max-w-[38%] shrink-0 truncate text-[10px] text-v2-text-text-faint">
              {projectName()}
            </span>
          )}
        </Show>
      </button>
      <div
        class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/session:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <HomeNavSessionMenu
          session={props.session}
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
          pinned={props.pinned}
          pinSession={props.pinSession}
          unpinSession={props.unpinSession}
          renameSession={props.renameSession}
          archiveSession={props.archiveSession}
          restoreSession={props.restoreSession}
          deleteSession={props.deleteSession}
          language={props.language}
        />
      </div>
    </div>
  )
}

function HomeSessionStatusGlyph(props: { status: SessionNavStatus }) {
  return (
    <Switch>
      <Match when={props.status === "attention"}>
        <span class="size-1.5 rounded-full bg-v2-state-bg-warning" />
      </Match>
      <Match when={props.status === "working"}>
        <Thinking state="working" size={20} />
      </Match>
      <Match when={props.status === "loading"}>
        <Spinner class="size-3" />
      </Match>
      <Match when={props.status === "unread"}>
        <span class="size-1.5 rounded-full bg-v2-state-bg-info" />
      </Match>
      <Match when={props.status === "settled"}>
        <IconV2 name="check" size="small" />
      </Match>
    </Switch>
  )
}

function sessionNavStatusLabel(status: SessionNavStatus) {
  switch (status) {
    case "attention":
      return "Needs your attention"
    case "working":
      return "In progress"
    case "loading":
      return "Loading"
    case "unread":
      return "New result"
    case "settled":
      return "Settled"
    default:
      return "Settled"
  }
}

function HomeNavSessionMenu(props: {
  session: Session
  open: boolean
  onOpenChange: (open: boolean) => void
  pinned?: boolean
  pinSession?: (session: Session) => void
  unpinSession?: (session: Session) => void
  renameSession?: (session: Session) => void
  archiveSession?: (session: Session) => void
  restoreSession?: (session: Session) => void
  deleteSession?: (session: Session) => void
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <MenuV2 gutter={6} modal={false} placement="bottom-end" open={props.open} onOpenChange={props.onOpenChange}>
      <MenuV2.Trigger
        as={IconButtonV2}
        data-action="home-nav-session-menu"
        variant="ghost-muted"
        size="small"
        icon={<IconV2 name="outline-dots" />}
        aria-label={props.language.t("common.moreOptions")}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <Show when={props.pinned ? props.unpinSession : props.pinSession}>
            {(togglePin) => (
              <MenuV2.Item
                data-action={props.pinned ? "home-nav-session-unpin" : "home-nav-session-pin"}
                onSelect={() => togglePin()(props.session)}
              >
                {props.language.t(props.pinned ? "common.unpin" : "common.pin")}
              </MenuV2.Item>
            )}
          </Show>
          <Show when={props.renameSession}>
            {(rename) => (
              <MenuV2.Item data-action="home-nav-session-rename" onSelect={() => rename()(props.session)}>
                {props.language.t("common.rename")}
              </MenuV2.Item>
            )}
          </Show>
          <Show when={props.archiveSession}>
            {(archive) => (
              <MenuV2.Item data-action="home-nav-session-archive" onSelect={() => archive()(props.session)}>
                {props.language.t("common.archive")}
              </MenuV2.Item>
            )}
          </Show>
          <Show when={props.restoreSession}>
            {(restore) => (
              <MenuV2.Item data-action="home-nav-session-restore" onSelect={() => restore()(props.session)}>
                {props.language.t("session.restore")}
              </MenuV2.Item>
            )}
          </Show>
          <Show when={props.deleteSession}>
            {(remove) => (
              <>
                <MenuV2.Separator />
                <MenuV2.Item data-action="home-nav-session-delete" onSelect={() => remove()(props.session)}>
                  {props.language.t("common.delete")}
                </MenuV2.Item>
              </>
            )}
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

// Inbox rows read denser than library rows: tinted by urgency, with a status
// line instead of a trailing project tag, and an explicit Open action.
function HomeInboxRow(props: {
  record: HomeSessionRecord
  status: () => SessionNavStatus
  openSession: (session: Session, options?: OpenSessionOptions) => void
  renameSession: (session: Session) => void
  archiveSession: (session: Session) => void
  deleteSession: (session: Session) => void
  pinned: boolean
  pinSession: (session: Session) => void
  unpinSession: (session: Session) => void
  language: ReturnType<typeof useLanguage>
}) {
  const [state, setState] = createStore({ menuOpen: false })
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const meta = createMemo(() => {
    const session = props.record.session
    const age = DateTime.fromMillis(session.time.updated ?? session.time.created).toRelative({
      style: "narrow",
    })
    const line = [sessionNavStatusLabel(props.status()), props.record.projectName, age ?? ""]
      .filter(Boolean)
      .join(" · ")
    if (sessionOrigin(session) === "automation") return `${sessionOriginLabel("automation")} · ${line}`
    return line
  })
  const tint = createMemo(() => {
    switch (props.status()) {
      case "attention":
        return "bg-v2-state-bg-warning"
      case "unread":
        return "bg-v2-state-bg-info"
      default:
        return "bg-v2-background-bg-layer-02"
    }
  })
  const open = (event: MouseEvent) => props.openSession(props.record.session, { background: isBackgroundOpen(event) })
  return (
    <div
      class={`group/session relative flex min-w-0 items-center rounded-[7px] [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] transition-[background-color] duration-[120ms] ease-in-out ${tint()} hover:bg-v2-background-bg-layer-03`}
    >
      <button
        type="button"
        data-component="home-inbox-row"
        data-status={props.status()}
        class="flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-[7px] py-1.5 pl-2.5 pr-[88px] text-left focus-visible:outline-none"
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onClick={open}
        onAuxClick={(event) => {
          if (!isBackgroundOpen(event)) return
          event.preventDefault()
          props.openSession(props.record.session, { background: true })
        }}
      >
        <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted" aria-hidden="true">
          <HomeSessionStatusGlyph status={props.status()} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[12px] leading-4 text-v2-text-text-base [font-weight:530]">{title()}</span>
          <span class="block truncate text-[10.5px] leading-[14px] text-v2-text-text-faint">{meta()}</span>
        </span>
      </button>
      <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <div
          class="hover-reveal flex items-center group-hover/session:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
          data-menu={state.menuOpen}
        >
          <HomeNavSessionMenu
            session={props.record.session}
            open={state.menuOpen}
            onOpenChange={(open) => setState("menuOpen", open)}
            pinned={props.pinned}
            pinSession={props.pinSession}
            unpinSession={props.unpinSession}
            renameSession={props.renameSession}
            archiveSession={props.archiveSession}
            deleteSession={props.deleteSession}
            language={props.language}
          />
        </div>
        <ButtonV2
          variant="ghost-muted"
          size="small"
          class="h-[22px] px-2 text-[10.5px] [font-weight:530]"
          onClick={open}
        >
          Open
        </ButtonV2>
      </div>
    </div>
  )
}

function HomeProjectEmpty(props: {
  server: ServerConnection.Any
  recentlyClosed: LocalProject[]
  homedir: string
  chooseProject: (server: ServerConnection.Any) => void
  openRecentProject: (server: ServerConnection.Any, directory: string) => void
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const unreachable = () => global.servers.health[ServerConnection.key(props.server)]?.healthy === false
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-action="home-add-project-row"
        class={`${HOME_PROJECT_NAV_ROW} disabled:opacity-60 [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
        disabled={unreachable()}
        onClick={() => props.chooseProject(props.server)}
      >
        <IconV2 name="folder-add-left" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("home.project.add")}</span>
      </button>
      <Show when={props.recentlyClosed.length > 0}>
        <div class="mt-3 flex h-7 min-w-0 shrink-0 items-center pl-1.5 pr-3">
          <div class="text-v2-text-text-faint [font-weight:530]">{props.language.t("home.recentlyClosed")}</div>
        </div>
        <For each={props.recentlyClosed}>
          {(project) => (
            <HomeRecentlyClosedRow
              project={project}
              server={props.server}
              homedir={props.homedir}
              openRecentProject={props.openRecentProject}
              language={props.language}
            />
          )}
        </For>
      </Show>
    </div>
  )
}

function HomeRecentlyClosedRow(props: {
  project: LocalProject
  server: ServerConnection.Any
  homedir: string
  openRecentProject: (server: ServerConnection.Any, directory: string) => void
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const unreachable = () => global.servers.health[ServerConnection.key(props.server)]?.healthy === false
  const path = () => {
    const home = props.homedir
    const worktree = props.project.worktree
    if (home && (worktree === home || worktree.startsWith(`${home}/`))) return `~${worktree.slice(home.length)}`
    return worktree
  }
  return (
    <TooltipV2 placement="right" value={path()}>
      <button
        type="button"
        data-component="home-recently-closed-row"
        class={`${HOME_PROJECT_NAV_ROW} disabled:opacity-60`}
        disabled={unreachable()}
        onClick={() => props.openRecentProject(props.server, props.project.worktree)}
      >
        <HomeProjectAvatar project={props.project} outline />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </button>
    </TooltipV2>
  )
}

function HomeProjectMenuItems(props: {
  project: LocalProject
  server: ServerConnection.Any
  unseenCount: number
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  language: ReturnType<typeof useLanguage>
}) {
  const platform = usePlatform()
  const canRevealInFileManager = () =>
    platform.platform === "desktop" && !!platform.openPath && ServerConnection.local(props.server)
  const fileManagerActionLabel = () =>
    props.language.t(
      fileManagerApp(platform.platform === "desktop" ? (platform.os ?? "unknown") : "unknown").actionLabel,
    )
  const revealInFileManager = () => {
    if (!platform.openPath) return
    platform.openPath(props.project.worktree).catch((err: unknown) =>
      showToast({
        title: props.language.t("common.requestFailed"),
        description: errorMessage(err, props.language.t("common.requestFailed")),
      }),
    )
  }
  return (
    <>
      <MenuV2.Item onSelect={() => props.openNewSession(props.server, props.project.worktree)}>
        {props.language.t("command.session.new")}
      </MenuV2.Item>
      <MenuV2.Item onSelect={() => props.editProject(props.server, props.project)}>
        {props.language.t("dialog.project.edit.title")}
      </MenuV2.Item>
      <Show when={canRevealInFileManager()}>
        <MenuV2.Item onSelect={revealInFileManager}>{fileManagerActionLabel()}</MenuV2.Item>
      </Show>
      <MenuV2.Item
        disabled={props.unseenCount === 0}
        onSelect={() => props.clearNotifications(props.server, props.project)}
      >
        {props.language.t("sidebar.project.clearNotifications")}
      </MenuV2.Item>
      <MenuV2.Separator />
      <MenuV2.Item onSelect={() => props.closeProject(props.server, props.project.worktree)}>
        {props.language.t("common.close")}
      </MenuV2.Item>
    </>
  )
}

function HomeProjectAvatar(props: { project: LocalProject; outline?: boolean }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={props.outline ? undefined : getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={props.outline ? "outline" : getProjectAvatarVariant(props.project.icon?.color)}
      pixelSeed={props.project.id ?? props.project.worktree}
    />
  )
}

function HomeSessionLeading(props: {
  project: LocalProject
  session: Session
  server: ServerConnection.Key
  revealProjectOnHover: boolean
}) {
  const tabs = useTabs()
  const hasOpenTab = createMemo(() => sessionHasOpenTab(tabs.store, props.server, props.session))
  return (
    <div class="relative shrink-0">
      <Show when={hasOpenTab()}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
          style={{ right: "calc(100% + 4px)" }}
        />
      </Show>
      <SessionTabAvatar
        project={props.project}
        directory={props.session.directory}
        sessionId={props.session.id}
        server={props.server}
        revealProjectOnHover={props.revealProjectOnHover}
      />
    </div>
  )
}

function HomeSessionSearch(props: {
  value: string
  placeholder: string
  open: boolean
  loading: boolean
  results: HomeSessionRecord[]
  showProjectName: boolean
  server: ServerConnection.Key
  noResultsLabel: string
  bindFocus: (focus: () => void) => void
  onInput: (value: string) => void
  onFocus: () => void
  onClose: () => void
  onSelect: (session: Session, options?: OpenSessionOptions) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ active: "" })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const focusInput = () => {
    input?.focus()
    props.onFocus()
  }

  onMount(() => {
    props.bindFocus(focusInput)
  })

  const syncActive = (results: HomeSessionRecord[]) => {
    if (results.length === 0) {
      setStore("active", "")
      return
    }
    if (!results.some((record) => homeSessionSearchKey(record) === store.active)) {
      setStore("active", homeSessionSearchKey(results[0]))
    }
  }

  createEffect(() => syncActive(props.results))

  createEffect(
    on(
      () => props.value,
      () => syncActive(props.results),
    ),
  )

  const scrollActiveIntoView = () => {
    const key = store.active
    if (!key || !listRef) return
    const element = listRef.querySelector<HTMLElement>(`[data-key="${key}"]`)
    element?.scrollIntoView({ block: "nearest" })
  }

  const moveActive = (delta: number) => {
    const results = props.results
    if (results.length === 0) return
    const index = results.findIndex((record) => homeSessionSearchKey(record) === store.active)
    const start = index === -1 ? 0 : index
    const next = (start + delta + results.length) % results.length
    setStore("active", homeSessionSearchKey(results[next]))
    scrollActiveIntoView()
  }

  const selectActive = () => {
    const record = props.results.find((item) => homeSessionSearchKey(item) === store.active)
    if (!record) return
    props.onSelect(record.session)
  }

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!props.open) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (root?.contains(target)) return
      props.onClose()
    }),
  )

  return (
    <div class="min-w-0 flex-1">
      <div ref={root} data-component="home-session-search" class="relative z-30 w-full">
        <Show when={props.open}>
          <div
            data-component="home-session-search-panel"
            class="absolute flex flex-col overflow-hidden rounded-[12px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
            style={{
              top: "-6px",
              left: "-6px",
              width: "calc(100% + 12px)",
            }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-4 pt-4">
                <Show
                  when={!props.loading}
                  fallback={
                    <div class="flex items-center justify-center px-4 py-3 text-v2-text-text-muted [font-weight:440]">
                      <Spinner class="size-4" />
                    </div>
                  }
                >
                  <Show
                    when={props.results.length > 0}
                    fallback={
                      <p class="my-1.5 px-4 pb-2 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {props.noResultsLabel}
                      </p>
                    }
                  >
                    <div class="flex flex-col">
                      <p class="my-1.5 pl-[18px] pr-6 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {language.t("home.sessions.search.sessions")}
                      </p>
                      <ScrollView class="max-h-80" viewportRef={(el) => (listRef = el)}>
                        <div class="flex flex-col gap-px pb-2">
                          <For each={props.results}>
                            {(record) => (
                              <HomeSessionSearchResultRow
                                record={record}
                                showProjectName={props.showProjectName}
                                server={props.server}
                                selected={store.active === homeSessionSearchKey(record)}
                                onHighlight={() => setStore("active", homeSessionSearchKey(record))}
                                onSelect={(session, options) => props.onSelect(session, options)}
                              />
                            )}
                          </For>
                        </div>
                      </ScrollView>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label class="relative z-20 flex h-9 w-full items-center gap-2 rounded-[6px] bg-v2-background-bg-layer-02/60 py-1 pl-3 pr-2 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-02 focus-within:bg-v2-background-bg-layer-02">
          <IconV2 name="magnifying-glass" />
          <input
            ref={input}
            class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
            value={props.value}
            placeholder={props.placeholder}
            aria-label={props.placeholder}
            aria-expanded={props.open}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              store.active && props.open ? `home-session-search-option-${store.active}` : undefined
            }
            onFocus={() => props.onFocus()}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.onClose()
                input?.blur()
                return
              }
              if (!props.open || props.results.length === 0) return
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActive(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActive(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                selectActive()
              }
            }}
          />
          <Show when={props.value}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={props.placeholder}
              onClick={() => {
                props.onClose()
                input?.focus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchResultRow(props: {
  record: HomeSessionRecord
  showProjectName: boolean
  server: ServerConnection.Key
  selected: boolean
  onHighlight: () => void
  onSelect: (session: Session, options?: OpenSessionOptions) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName && props.record.projectName

  const key = () => homeSessionSearchKey(props.record)

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      role="option"
      aria-selected={props.selected}
      classList={{
        [HOME_SEARCH_RESULT_ROW]: true,
        "bg-v2-overlay-simple-overlay-hover": props.selected,
        group: !!showProjectName(),
      }}
      onMouseEnter={() => props.onHighlight()}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onSelect(props.record.session, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onSelect(props.record.session, { background: true })
      }}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        revealProjectOnHover={!!showProjectName()}
      />
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          class={`${HOME_SEARCH_RESULT_TITLE} ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class={HOME_SEARCH_RESULT_META}>{props.record.projectName}</span>
        </Show>
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: {
  title: string
  titleOpacity: number
  ref: ComponentProps<"div">["ref"]
  elevated?: boolean
}) {
  return (
    <div
      ref={props.ref}
      class={`pointer-events-none sticky top-[84px] lg:top-[108px] flex h-7 min-w-0 items-center justify-between pl-3 bg-v2-background-bg-base ${props.elevated ? "home-session-group-header z-[5]" : "z-10"}`}
    >
      <div class={HOME_SECTION_LABEL} style={{ opacity: props.titleOpacity }}>
        {props.title}
      </div>
    </div>
  )
}

function HomeSessionRow(props: {
  record: HomeSessionRecord
  showProjectName: boolean
  server: ServerConnection.Key
  openSession: (session: Session, options?: OpenSessionOptions) => void
  archiveSession: (session: Session) => Promise<void>
}) {
  const language = useLanguage()
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName && props.record.projectName

  return (
    <div
      class="group/session relative flex h-10 min-w-0 items-center rounded-[6px]"
      classList={{ group: !!showProjectName() }}
    >
      <button
        type="button"
        data-component="home-session-row"
        class={`${HOME_ROW} h-10 min-w-0 flex-1 gap-2 py-3 pl-3 pr-10`}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onClick={(event) => props.openSession(props.record.session, { background: isBackgroundOpen(event) })}
        onAuxClick={(event) => {
          if (!isBackgroundOpen(event)) return
          event.preventDefault()
          props.openSession(props.record.session, { background: true })
        }}
      >
        <HomeSessionLeading
          project={props.record.project}
          session={props.record.session}
          server={props.server}
          revealProjectOnHover={!!showProjectName()}
        />
        <span
          class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
            {props.record.projectName}
          </span>
        </Show>
      </button>
      <Show when={SHOW_HOME_SESSION_ARCHIVE}>
        <div class="hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/session:opacity-100 focus-within:opacity-100">
          <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("common.archive")}>
            <IconButtonV2
              data-action="home-session-archive"
              variant="ghost-muted"
              size="large"
              icon={<IconV2 name="archive" />}
              aria-label={language.t("common.archive")}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void props.archiveSession(props.record.session)
              }}
            />
          </TooltipV2>
        </div>
      </Show>
    </div>
  )
}

function HomeSessionsEmpty(props: { onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex min-h-full flex-col items-center gap-4 px-6 pt-[52px] text-center">
      <div class="shrink-0 text-[13px] leading-[13px] tracking-[-0.04px] text-v2-text-text-base [font-weight:530]">
        {language.t("home.sessions.empty")}
      </div>
      <p class="mb-1 text-center text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
        {language.t("home.sessions.empty.description")}
      </p>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2 data-action="home-new-session" variant="neutral" size="normal" icon="edit" onClick={onNewSession()}>
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

export function LegacyHome() {
  const sync = useServerSync()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync().data.path.home)
  const serverUnreachable = createMemo(() => global.servers.health[server.key]?.healthy === false)
  const recent = createMemo(() => {
    return sync()
      .data.project.slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const serverDotClass = createMemo(() => {
    const healthy = global.servers.health[server.key]?.healthy
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(server: ServerConnection.Any, directory: string) {
    const serverCtx = global.ensureServerCtx(server)
    serverCtx.projects.open(directory)
    serverCtx.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  function chooseProject() {
    if (serverUnreachable()) return
    const s = server.current
    if (!s) return

    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(s, directory)
        }
      } else if (result) {
        openProject(s, result)
      }
    }

    pickDirectory({
      server: s,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            [serverDotClass()]: true,
          }}
        />
        {server.name}
      </Button>
      <Switch>
        <Match when={sync().data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button
                icon="folder-add-left"
                size="normal"
                class="pl-2 pr-3"
                disabled={serverUnreachable()}
                onClick={chooseProject}
              >
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(server.current!, project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync().ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" disabled={serverUnreachable()} onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" disabled={serverUnreachable()} onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
