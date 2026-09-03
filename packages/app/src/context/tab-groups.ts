import type { ServerConnection } from "./server"
import { tabKey, type Tab } from "./tab"

export const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

export type TabGroup = {
  id: string
  name: string
  color: TabGroupColor
  collapsed: boolean
  tabs: Tab[]
}

export type TabGroupLayoutEntry = { type: "tab"; tab: Tab } | { type: "group"; group: TabGroup; tabs: Tab[] }

export function createTabGroup(input: {
  id: string
  tabs: Tab[]
  name?: string
  color?: TabGroupColor
  collapsed?: boolean
}) {
  const keys = new Set<string>()
  const tabs = input.tabs.filter((tab) => {
    const key = tabKey(tab)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })

  if (!input.id || !tabs.length) return
  return {
    id: input.id,
    name: input.name?.trim() ?? "",
    color: input.color ?? "grey",
    collapsed: input.collapsed ?? false,
    tabs,
  }
}

export function migrateTabGroups(value: unknown, fallback?: ServerConnection.Key): TabGroup[] {
  if (!Array.isArray(value)) return []

  const ids = new Set<string>()
  const claimed = new Set<string>()
  return value.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return []
    if (ids.has(value.id)) return []

    const group = createTabGroup({
      id: value.id,
      name: value.name,
      color: isTabGroupColor(value.color) ? value.color : undefined,
      collapsed: value.collapsed === true,
      tabs: Array.isArray(value.tabs) ? value.tabs.flatMap((tab) => tabGroupMember(tab, fallback)) : [],
    })
    if (!group) return []

    const tabs = group.tabs.filter((tab) => {
      const key = tabKey(tab)
      if (claimed.has(key)) return false
      claimed.add(key)
      return true
    })
    if (!tabs.length) return []

    ids.add(group.id)
    return [{ ...group, tabs }]
  })
}

export function tabGroupForTab(groups: TabGroup[], tab: Tab) {
  const key = tabKey(tab)
  return groups.find((group) => group.tabs.some((member) => tabKey(member) === key))
}

export function assignTabToGroup(groups: TabGroup[], id: string, tab: Tab) {
  const target = groups.find((group) => group.id === id)
  if (!target) return groups

  const key = tabKey(tab)
  if (target.tabs.some((member) => tabKey(member) === key)) return groups

  return groups.flatMap((group) => {
    const tabs = group.tabs.filter((member) => tabKey(member) !== key)
    if (group.id === id) return [{ ...group, tabs: [...tabs, tab] }]
    return tabs.length ? [{ ...group, tabs }] : []
  })
}

export function removeTabsFromTabGroups(groups: TabGroup[], tabs: Tab[]) {
  const keys = new Set(tabs.map(tabKey))
  if (!keys.size) return groups

  return groups.flatMap((group) => {
    const tabs = group.tabs.filter((tab) => !keys.has(tabKey(tab)))
    if (tabs.length === group.tabs.length) return [group]
    return tabs.length ? [{ ...group, tabs }] : []
  })
}

export function replaceTabInTabGroups(groups: TabGroup[], current: Tab, next: Tab) {
  const currentKey = tabKey(current)
  const nextKey = tabKey(next)
  const source = groups.find((group) => group.tabs.some((tab) => tabKey(tab) === currentKey))
  if (!source) return groups

  return groups.flatMap((group) => {
    const tabs = group.tabs.flatMap((tab) => {
      const key = tabKey(tab)
      if (key === currentKey) return group.id === source.id ? [next] : []
      if (key === nextKey) return []
      return [tab]
    })
    return tabs.length ? [{ ...group, tabs }] : []
  })
}

export function syncTabGroups(groups: TabGroup[], tabs: Tab[]) {
  const open = new Map(tabs.map((tab) => [tabKey(tab), tab]))
  const claimed = new Set<string>()

  return groups.flatMap((group) => {
    const tabs = group.tabs.flatMap((tab) => {
      const key = tabKey(tab)
      const current = open.get(key)
      if (!current || claimed.has(key)) return []
      claimed.add(key)
      return [current]
    })
    return tabs.length ? [{ ...group, tabs }] : []
  })
}

export function tabGroupLayout(tabs: Tab[], groups: TabGroup[]): TabGroupLayoutEntry[] {
  const byTab = new Map(groups.flatMap((group) => group.tabs.map((tab) => [tabKey(tab), group] as const)))
  const emitted = new Set<string>()

  return tabs.flatMap<TabGroupLayoutEntry>((tab) => {
    const group = byTab.get(tabKey(tab))
    if (!group) return [{ type: "tab" as const, tab }]
    if (emitted.has(group.id)) return []
    emitted.add(group.id)
    return [
      {
        type: "group" as const,
        group,
        tabs: tabs.filter((tab) => byTab.get(tabKey(tab))?.id === group.id),
      },
    ]
  })
}

export function normalizeTabOrder(tabs: Tab[], groups: TabGroup[]) {
  return tabGroupLayout(tabs, groups).flatMap((entry) => (entry.type === "tab" ? [entry.tab] : entry.tabs))
}

export function tabGroupDragKey(id: string) {
  return `tab-group:${id}`
}

export function tabGroupDragLayout(tabs: Tab[], groups: TabGroup[]) {
  return tabGroupLayout(tabs, groups).flatMap((entry) =>
    entry.type === "tab" ? [tabKey(entry.tab)] : [tabGroupDragKey(entry.group.id), ...entry.tabs.map(tabKey)],
  )
}

export function moveTabToGroup(tabs: Tab[], group: TabGroup, tab: Tab) {
  const key = tabKey(tab)
  if (group.tabs.some((member) => tabKey(member) === key)) return tabs

  const moving = tabs.find((member) => tabKey(member) === key)
  if (!moving) return tabs

  const groupKeys = new Set(group.tabs.map(tabKey))
  const remaining = tabs.filter((member) => tabKey(member) !== key)
  const index = remaining.findLastIndex((member) => groupKeys.has(tabKey(member)))
  if (index === -1) return tabs
  return [...remaining.slice(0, index + 1), moving, ...remaining.slice(index + 1)]
}

export function reconcileTabGroupsAfterReorder(
  groups: TabGroup[],
  tabs: Tab[],
  movedKey: string,
  dragLayout: string[],
) {
  if (!tabs.some((tab) => tabKey(tab) === movedKey)) return groups
  const source = groups.find((group) => group.tabs.some((tab) => tabKey(tab) === movedKey))
  const target = groups.find((group) => group.id !== source?.id && tabIsInsideGroup(group, movedKey, dragLayout))
  const moved = tabs.find((tab) => tabKey(tab) === movedKey)
  if (target && moved) return assignTabToGroup(groups, target.id, moved)
  if (!source || source.tabs.length === 1) return groups
  if (tabIsInsideGroup(source, movedKey, dragLayout)) return groups
  return removeTabsFromTabGroups(
    groups,
    source.tabs.filter((tab) => tabKey(tab) === movedKey),
  )
}

export function moveTabGroup(tabs: Tab[], groups: TabGroup[], id: string, dragLayout: string[]) {
  const group = groups.find((group) => group.id === id)
  const headerIndex = dragLayout.indexOf(tabGroupDragKey(id))
  if (!group || headerIndex === -1) return tabs

  const groupKeys = new Set(group.tabs.map(tabKey))
  const moving = tabs.filter((tab) => groupKeys.has(tabKey(tab)))
  const remaining = tabs.filter((tab) => !groupKeys.has(tabKey(tab)))
  const nextID = dragLayout.slice(headerIndex + 1).find((id) => !groupKeys.has(id))
  const targetGroupKeys = new Set(groups.find((group) => tabGroupDragKey(group.id) === nextID)?.tabs.map(tabKey) ?? [])
  const targetKey = remaining.map(tabKey).find((key) => key === nextID || targetGroupKeys.has(key))
  const targetIndex = targetKey ? remaining.findIndex((tab) => tabKey(tab) === targetKey) : remaining.length
  return normalizeTabOrder([...remaining.slice(0, targetIndex), ...moving, ...remaining.slice(targetIndex)], groups)
}

export function toggleTabGroup(groups: TabGroup[], id: string) {
  if (!groups.some((group) => group.id === id)) return groups
  return groups.map((group) => (group.id === id ? { ...group, collapsed: !group.collapsed } : group))
}

export function nextTabGroupColor(groups: TabGroup[]) {
  return (
    TAB_GROUP_COLORS.find((color) => !groups.some((group) => group.color === color)) ??
    TAB_GROUP_COLORS[groups.length % TAB_GROUP_COLORS.length]!
  )
}

export function removeTabGroupSessions(groups: TabGroup[], server: ServerConnection.Key, sessionIDs: string[]) {
  const removed = new Set(sessionIDs)
  return groups.flatMap((group) => {
    const tabs = group.tabs.filter(
      (tab) => tab.type !== "session" || tab.server !== server || !removed.has(tab.sessionId),
    )
    return tabs.length ? [{ ...group, tabs }] : []
  })
}

export function removeTabGroupServer(groups: TabGroup[], server: ServerConnection.Key) {
  return groups.flatMap((group) => {
    const tabs = group.tabs.filter((tab) => tab.server !== server)
    return tabs.length ? [{ ...group, tabs }] : []
  })
}

function tabGroupMember(value: unknown, fallback?: ServerConnection.Key): Tab[] {
  if (!isRecord(value)) return []
  const server = typeof value.server === "string" ? (value.server as ServerConnection.Key) : fallback
  if (!server) return []

  if (value.type === "session" && typeof value.sessionId === "string") {
    return [{ type: "session", server, sessionId: value.sessionId }]
  }

  if (value.type !== "draft" || typeof value.draftID !== "string" || typeof value.directory !== "string") return []
  return [
    {
      type: "draft",
      server,
      draftID: value.draftID,
      directory: value.directory,
      ...(typeof value.worktree === "string" ? { worktree: value.worktree } : {}),
    },
  ]
}

function tabIsInsideGroup(group: TabGroup, movedKey: string, dragLayout: string[]) {
  const headerIndex = dragLayout.indexOf(tabGroupDragKey(group.id))
  const movedIndex = dragLayout.indexOf(movedKey)
  if (headerIndex === -1 || movedIndex <= headerIndex) return false

  const members = new Set(group.tabs.map(tabKey))
  return dragLayout.slice(headerIndex + 1, movedIndex + 1).every((key) => key === movedKey || members.has(key))
}

function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === "string" && TAB_GROUP_COLORS.includes(value as TabGroupColor)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
