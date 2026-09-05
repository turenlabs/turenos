import type { Session } from "@turenlabs/sdk/v2/client"
import { createSimpleContext } from "@turenlabs/ui/context"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { batch, createEffect, createSignal, getOwner, onCleanup } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useIsRouting } from "@/hooks/use-is-routing"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { createTabMemory } from "./tab-memory"
import {
  nextTabAfterClose,
  pushClosedTabs,
  removeClosedTabs,
  takeClosedTab,
  unretainedDraftIDs,
  type ClosedTab,
} from "./closed-tabs"
import { createDraftPromptSession, type PromptModel } from "./prompt-state"
import { startupTrace } from "@/utils/startup-trace"
import { currentTabIndexForClose, currentTabIndexForSessionRemoval, isServerRoute } from "./tab-removal"
import type { SessionLiveView } from "@/session-live-view"
import {
  assignTabToGroup,
  createTabGroup,
  migrateTabGroups,
  moveTabToGroup,
  moveTabGroup,
  nextTabGroupColor,
  normalizeTabOrder,
  reconcileTabGroupsAfterReorder,
  removeTabGroupServer,
  removeTabGroupSessions,
  removeTabsFromTabGroups,
  replaceTabInTabGroups,
  syncTabGroups,
  tabGroupForTab,
  toggleTabGroup,
  type TabGroup,
  type TabGroupColor,
} from "./tab-groups"
import {
  draftHref,
  migrateTabs,
  promoteDraftTab,
  tabHref,
  tabKey,
  type DraftTab,
  type SessionTab,
  type Tab,
} from "./tab"
import { createTabNavigationIntent } from "./tab-navigation-intent"

export { draftHref, tabHref, tabKey, type DraftTab, type SessionTab, type Tab } from "./tab"

export type TabInfo = {
  title?: string
  directory?: string
}

type RecentTab = {
  key?: string
}

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.window("tabs"),
        migrate: (value: unknown) => migrateTabs(value, fallback),
      },
      createStore<Tab[]>([]),
    )
    const [liveView, setLiveView] = createSignal<SessionLiveView>("history")
    const [recent, setRecent, , recentReady] = persisted(Persist.window("tabs.recent"), createStore<RecentTab>({}))
    const [info, setInfo] = persisted(Persist.window("tabs.info"), createStore<Record<string, TabInfo>>({}))
    const [closed, setClosed, , closedReady] = persisted(Persist.window("tabs.closed"), createStore<ClosedTab[]>([]))
    const [groups, setGroups, , groupsReady] = persisted(
      {
        ...Persist.window("tabs.groups"),
        migrate: (value: unknown) => migrateTabGroups(value, fallback),
      },
      createStore<TabGroup[]>([]),
    )
    const startupTraceID = crypto.randomUUID()
    startupTrace("tabs", "restore.started", { startupTraceID })
    void Promise.all([ready.promise, recentReady.promise]).then(() => {
      startupTrace("tabs", "restore.completed", {
        startupTraceID,
        tabCount: store.length,
        hasRecentTab: Boolean(recent.key),
      })
    })

    const params = useParams()
    const isRouting = useIsRouting()
    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory(getOwner())
    const navigationIntent = createTabNavigationIntent()

    let recentWrite = 0
    let recentValue: string | undefined
    const recentKey = () => (recentWrite ? recentValue : recent.key)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) setRecent("key", key)
      })
    }

    const updateClosed = (update: (stack: ClosedTab[]) => ClosedTab[]) => {
      const apply = () => {
        const previous = [...closed]
        const next = update(previous)
        setClosed(() => next)
        removeUnretainedDrafts(previous.map((entry) => entry.tab))
      }
      if (closedReady()) {
        apply()
        return
      }
      void closedReady.promise?.then(apply)
    }

    const deferGroups = (action: () => void) => {
      if (groupsReady()) return false
      void groupsReady.promise?.then(action)
      return true
    }

    const updateGroups = (update: (groups: TabGroup[]) => TabGroup[]) => {
      const apply = () => setGroups((groups) => update(groups))
      if (deferGroups(apply)) return
      apply()
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) removePersisted(Persist.draft(draftID, key), platform)
    }

    const removeUnretainedDrafts = (candidates: Tab[]) => {
      for (const draftID of unretainedDraftIDs(candidates, [...store, ...closed.map((entry) => entry.tab)])) {
        removeDraftPersisted(draftID)
      }
    }

    const removeInfo = (key: string) => {
      if (!info[key]) return
      setInfo(
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => servers.has(tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!servers.has(tab.server)) {
            const key = tabKey(tab)
            memory.remove(key)
            removeInfo(key)
          }
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
      const keys = new Set(next.map(tabKey))
      for (const key of Object.keys(info)) {
        if (!keys.has(key)) removeInfo(key)
      }
    })

    createEffect(() => {
      if (!closedReady() || !ready()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = closed.filter((entry) => servers.has(entry.tab.server))
      if (next.length !== closed.length) updateClosed(() => next)
    })

    createEffect(() => {
      if (!groupsReady() || !ready()) return
      const next = syncTabGroups(
        groups,
        store.filter((tab) => server.list.some((connection) => ServerConnection.key(connection) === tab.server)),
      )
      const groupsChanged =
        next.length !== groups.length ||
        next.some((group, index) => {
          const previous = groups[index]
          if (!previous || group.id !== previous.id || group.tabs.length !== previous.tabs.length) return true
          return group.tabs.some((tab, tabIndex) => {
            const member = previous.tabs[tabIndex]
            if (!member || tabKey(tab) !== tabKey(member) || tab.server !== member.server) return true
            if (tab.type === "session" || member.type === "session") return tab.type !== member.type
            return tab.directory !== member.directory || tab.worktree !== member.worktree
          })
        })
      if (groupsChanged) setGroups(() => next)

      const ordered = normalizeTabOrder(store, next)
      if (ordered.some((tab, index) => !store[index] || tabKey(tab) !== tabKey(store[index]!))) setStore(() => ordered)
    })

    const expandGroupForTab = (tab: Tab) => {
      updateGroups((groups) => {
        const group = tabGroupForTab(groups, tab)
        if (!group?.collapsed) return groups
        return groups.map((current) => (current.id === group.id ? { ...current, collapsed: false } : current))
      })
    }

    const navigateTab = (tab: Tab) => {
      const key = tabKey(tab)
      batch(() => {
        navigationIntent.request(key)
        expandGroupForTab(tab)
        setRecentKey(key)
        navigate(tabHref(tab))
      })
    }

    const removeTabs = (targets: Tab[], recordClosed = false) => {
      if (recordClosed && !closedReady()) {
        void closedReady.promise?.then(() => removeTabs(targets, true))
        return
      }
      const keys = new Set(targets.map(tabKey))
      const removed = store.flatMap((tab, index) => (keys.has(tabKey(tab)) ? [{ tab, index }] : []))
      if (!removed.length) return
      const currentKey = recentKey()
      const currentIndex = currentTabIndexForClose({
        tabs: store,
        navigationKey: isRouting() ? navigationIntent.current()?.destinationKey : undefined,
        currentKey,
        pathname: location.pathname,
        routeDraftID: typeof location.query.draftId === "string" ? location.query.draftId : undefined,
        routeSessionID: params.id,
        selectedServer: server.key,
        legacyDirectory: params.dir,
      })
      const currentTab = store[currentIndex]
      const active = !!currentTab && keys.has(tabKey(currentTab))
      const nextTab = active
        ? keys.size === 1
          ? nextTabAfterClose(store, currentIndex, true)
          : (store.slice(0, currentIndex).findLast((tab) => !keys.has(tabKey(tab))) ??
            store.slice(currentIndex + 1).find((tab) => !keys.has(tabKey(tab))) ??
            null)
        : undefined
      // Record recovery before removing open tabs. A close during hydration
      // waits above so a relaunch cannot strand an unsaved draft outside both.
      if (recordClosed) updateClosed((stack) => pushClosedTabs(stack, removed))
      batch(() => {
        updateGroups((groups) => removeTabsFromTabGroups(groups, targets))
        setStore((tabs) => tabs.filter((tab) => !keys.has(tabKey(tab))))
        if (nextTab === null) {
          setRecentKey(undefined)
          navigate("/")
        }
        if (nextTab) navigateTab(nextTab)
      })
      for (const entry of removed) {
        const key = tabKey(entry.tab)
        memory.remove(key)
        removeInfo(key)
        if (entry.tab.type === "draft" && !recordClosed) removeDraftPersisted(entry.tab.draftID)
      }
      // A batch can close more tabs than the recovery limit retains.
      if (recordClosed) removeUnretainedDrafts(removed.map((entry) => entry.tab))
    }

    const removeTab = (index: number) => {
      const tab = store[index]
      if (tab) removeTabs([tab])
    }

    const actions = {
      addSessionTab: (tab: Omit<SessionTab, "type">) => {
        const next = { type: "session" as const, ...tab }
        const existing = store.find((item) => tabKey(item) === tabKey(next))
        if (existing) return existing
        setStore(
          produce((tabs) => {
            if (tabs.some((item) => tabKey(item) === tabKey(next))) return
            tabs.push(next)
          }),
        )
        return next
      },
      reorder(keys: string[], movedKey?: string, dragLayout = keys) {
        const byKey = new Map(store.map((tab) => [tabKey(tab), tab]))
        const next = keys.map((key) => byKey.get(key)).filter((tab): tab is Tab => !!tab)
        if (next.length !== store.length) return

        const reorderedGroups = movedKey ? reconcileTabGroupsAfterReorder(groups, next, movedKey, dragLayout) : groups
        const moved = movedKey ? next.find((tab) => tabKey(tab) === movedKey) : undefined
        const movedGroup = moved ? tabGroupForTab(reorderedGroups, moved) : undefined
        const nextGroups = movedGroup?.collapsed
          ? reorderedGroups.map((group) => (group.id === movedGroup.id ? { ...group, collapsed: false } : group))
          : reorderedGroups
        batch(() => {
          setStore(() => normalizeTabOrder(next, nextGroups))
          if (nextGroups !== groups) updateGroups(() => nextGroups)
        })
      },
      moveGroup(id: string, dragLayout: string[]) {
        setStore((tabs) => moveTabGroup(tabs, groups, id, dragLayout))
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      async newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string, model?: PromptModel) {
        const draftID = uuid()
        const tab = { type: "draft" as const, draftID, ...draft }
        const state = memory.ensure(tabKey(tab), "prompt", () => createDraftPromptSession(draftID, { prompt, model }))
        // This identity is new. Persist supplied defaults before the user can
        // close it; makePersisted otherwise only writes after the first edit.
        if (prompt !== undefined || model !== undefined) state.set(state.current(), state.cursor())
        batch(() => {
          setStore(
            produce((tabs) => {
              tabs.push(tab)
            }),
          )
          navigationIntent.request(tabKey(tab))
          navigate(draftHref(draftID))
        })
        return tab
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        setStore(
          (tab) => tab.type === "draft" && tab.draftID === draftID,
          produce((tab) => Object.assign(tab, draft)),
        )
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        // The Router can still report this draft while a later tab selection is pending.
        // Do not let a delayed promotion replace that newer destination.
        const intended = navigationIntent.current()
        const active =
          location.pathname === "/new-session" &&
          location.query.draftId === draftID &&
          (!intended || intended.destinationKey === `draft:${draftID}`)
        const next = { type: "session" as const, ...session }
        const current = store.find((tab) => tab.type === "draft" && tab.draftID === draftID)
        batch(() => {
          if (current) updateGroups((groups) => replaceTabInTabGroups(groups, current, next))
          setStore((tabs) => promoteDraftTab(tabs, draftID, next))
          updateClosed((stack) => stack.filter((entry) => entry.tab.type !== "draft" || entry.tab.draftID !== draftID))
          if (recentKey() === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        memory.remove(`draft:${draftID}`)
        removeDraftPersisted(draftID)
      },
      createGroup(input: { tab: Tab }) {
        if (deferGroups(() => actions.createGroup(input))) return
        const tab = store.find((tab) => tabKey(tab) === tabKey(input.tab))
        if (!tab) return
        const group = createTabGroup({
          id: uuid(),
          color: nextTabGroupColor(groups),
          tabs: [tab],
        })
        if (!group) return
        updateGroups((groups) => [...removeTabsFromTabGroups(groups, [tab]), group])
        return group
      },
      addTabToGroup(tab: Tab, id: string) {
        if (deferGroups(() => actions.addTabToGroup(tab, id))) return
        const current = store.find((item) => tabKey(item) === tabKey(tab))
        const target = groups.find((group) => group.id === id)
        if (!current || !target) return

        const assigned = assignTabToGroup(groups, id, current)
        if (assigned === groups) return
        const nextGroups = assigned.map((group) => (group.id === id ? { ...group, collapsed: false } : group))
        batch(() => {
          setStore(() => normalizeTabOrder(moveTabToGroup(store, target, current), nextGroups))
          updateGroups(() => nextGroups)
        })
      },
      removeTabFromGroup(tab: Tab) {
        updateGroups((groups) => removeTabsFromTabGroups(groups, [tab]))
      },
      updateGroup(id: string, input: { name?: string; color?: TabGroupColor }) {
        updateGroups((groups) =>
          groups.map((group) =>
            group.id === id
              ? {
                  ...group,
                  ...(input.name === undefined ? {} : { name: input.name.trim() }),
                  ...(input.color === undefined ? {} : { color: input.color }),
                }
              : group,
          ),
        )
      },
      deleteGroup(id: string) {
        updateGroups((groups) => groups.filter((group) => group.id !== id))
      },
      toggleGroup(id: string) {
        if (deferGroups(() => actions.toggleGroup(id))) return
        updateGroups((groups) => toggleTabGroup(groups, id))
      },
      closeGroup(id: string) {
        if (deferGroups(() => actions.closeGroup(id))) return
        const group = groups.find((group) => group.id === id)
        if (!group) return
        removeTabs(group.tabs, true)
      },
      removeTab,
      // User-initiated close: records the tab so it can be reopened.
      // Cleanup paths (missing sessions, archive, server removal) go through
      // removeTab and friends directly and are not recorded.
      closeTab(index: number) {
        const tab = store[index]
        if (!tab) return
        removeTabs([tab], true)
      },
      reopenClosedTab() {
        if (!closedReady() || !ready()) {
          void Promise.all([closedReady.promise, ready.promise]).then(() => actions.reopenClosedTab())
          return
        }
        const result = takeClosedTab(closed, store)
        if (result.stack.length === closed.length) return
        const entry = result.entry
        if (!entry) {
          updateClosed(() => result.stack)
          return
        }
        const index = Math.min(entry.index, store.length)
        batch(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(entry.tab))) return
              tabs.splice(index, 0, entry.tab)
            }),
          )
          updateClosed(() => result.stack)
          navigateTab(entry.tab)
        })
      },
      removeSessionTab(input: Omit<SessionTab, "type">) {
        updateClosed((stack) => removeClosedTabs(stack, input.server, [input.sessionId]))
        updateGroups((groups) => removeTabGroupSessions(groups, input.server, [input.sessionId]))
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index)
      },
      removeServer(key: ServerConnection.Key) {
        updateClosed((stack) => stack.filter((entry) => entry.tab.server !== key))
        updateGroups((groups) => removeTabGroupServer(groups, key))
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key || isServerRoute(location.pathname, key)) navigate("/")
        return Promise.resolve()
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server
        updateClosed((stack) => removeClosedTabs(stack, targetServer, input.sessionIDs))
        updateGroups((groups) => removeTabGroupSessions(groups, targetServer, input.sessionIDs))
        const sessionIDs = new Set(input.sessionIDs)
        const removedSession = (tab: Tab): tab is SessionTab =>
          tab.type === "session" && tab.server === targetServer && sessionIDs.has(tab.sessionId)
        const removed = store.filter(removedSession).map(tabKey)
        const currentRecentKey = recentKey()
        const currentIndex = currentTabIndexForSessionRemoval({
          tabs: store,
          targetServer,
          sessionIDs: input.sessionIDs,
          currentKey: currentRecentKey,
          pathname: location.pathname,
          routeSessionID: params.id,
          selectedServer: server.key,
          legacyDirectory: params.dir,
        })
        const nextTab =
          currentIndex === -1
            ? undefined
            : (store.slice(currentIndex + 1).find((tab) => !removedSession(tab)) ??
              store.slice(0, currentIndex).findLast((tab) => !removedSession(tab)) ??
              null)
        batch(() => {
          setStore((tabs) => tabs.filter((tab) => !removedSession(tab)))
          if (currentRecentKey && removed.includes(currentRecentKey)) setRecentKey(undefined)
          if (nextTab === null) navigate("/")
          if (nextTab) navigateTab(nextTab)
        })
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
      },
      rememberSessionInfo(tab: SessionTab, session: Session) {
        const key = tabKey(tab)
        const next = { title: session.title, directory: session.directory }
        const current = info[key]
        if (current?.title === next.title && current.directory === next.directory) return
        setInfo(key, next)
      },
      select: navigateTab,
      remember(tab: Tab) {
        expandGroupForTab(tab)
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          if (!ready() || !recentReady()) {
            const pathname = location.pathname
            void Promise.all([ready.promise, recentReady.promise]).then(() => {
              if (location.pathname === pathname) actions.toggleHome(input)
            })
            return
          }
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          else navigate("/")
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      state<T>(tab: Tab, name: string, init: () => T) {
        return memory.ensure(tabKey(tab), name, init)
      },
      stateValue<T>(tab: Tab, name: string) {
        return memory.get<T>(tabKey(tab), name)
      },
    }

    return {
      ...actions,
      store,
      info,
      groups,
      ready,
      recentReady,
      groupsReady,
      navigationIntent: navigationIntent.current,
      liveView,
      setLiveView,
    }
  },
})
