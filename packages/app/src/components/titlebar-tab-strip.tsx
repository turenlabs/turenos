import {
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@turenlabs/core/util/encode"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { tabGroupDragKey, tabGroupDragLayout, tabGroupLayout } from "@/context/tab-groups"
import { tabGroupStyle, TitlebarTabContextMenu, TitlebarTabGroupHeader } from "./titlebar-tab-groups"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  shortcutIndex: () => number
  active: () => boolean
  forceTruncate: boolean
  serverCtx: () => ServerCtx | undefined
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
  onEditGroup: (id: string) => void
  hidden?: boolean
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement
  useTabShortcut(props.shortcutIndex, () => props.onNavigate(ref))
  const sdk = createMemo(() => props.serverCtx()?.sdk ?? null)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [requested, setRequested] = createSignal(false)
  const [loadedSession] = createResource(
    () => {
      if (!requested()) return null
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const loading = createMemo(() => {
    if (requested() && loadedSession.loading) return true
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value) return false
    const state = ctx.sync.directoryState(value.directory)
    return state.status === "loading" || state.bootstrapping
  })
  let prefetched = false

  createEffect(() => {
    if (!props.active()) return
    setRequested(true)
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value || prefetched) return
    prefetched = true
    createRoot((dispose) => {
      try {
        void ctx.sync
          .ensureDirSyncContext(value.directory)
          .session.sync(value.id)
          .catch(() => {})
          .finally(dispose)
      } catch {
        dispose()
      }
    })
  })

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.directory),
      id: value.id,
    })
  })

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
      classList={{ hidden: props.hidden }}
    >
      <TitlebarTabContextMenu tab={props.tab} onClose={props.onClose} onEditGroup={props.onEditGroup}>
        <TabNavItem
          ref={(el) => {
            ref = el
          }}
          href={tabHref(props.tab)}
          server={props.tab.server}
          session={session}
          fallbackTitle={persisted()?.title ?? language.t("session.tab.unknown")}
          onTitleChange={(title) => {
            const value = session()
            const ctx = props.serverCtx()
            if (value && ctx) ctx.sync.session.remember({ ...value, title })
          }}
          onTitleChangeFailed={(title) => {
            const value = session()
            const ctx = props.serverCtx()
            if (value && ctx) ctx.sync.session.remember({ ...value, title })
          }}
          onNavigate={() => props.onNavigate(ref)}
          onClose={props.onClose}
          active={props.active()}
          forceTruncate={props.forceTruncate}
          dragging={sortable.isDragSource()}
          loading={loading()}
        />
      </TitlebarTabContextMenu>
    </div>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  shortcutIndex: () => number
  active: () => boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
  onEditGroup: (id: string) => void
  hidden?: boolean
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement
  useTabShortcut(props.shortcutIndex, () => props.onNavigate(ref))

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
      classList={{ hidden: props.hidden }}
    >
      <TitlebarTabContextMenu tab={props.tab} onClose={props.onClose} onEditGroup={props.onEditGroup}>
        <DraftTabItem
          ref={(el) => {
            ref = el
          }}
          href={tabHref(props.tab)}
          title={props.title}
          icon="edit"
          onNavigate={() => props.onNavigate(ref)}
          onClose={props.onClose}
          active={props.active()}
          dragging={sortable.isDragSource()}
        />
      </TitlebarTabContextMenu>
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[], movedKey?: string, dragLayout?: string[]) => void
  onToggleGroup: (id: string) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const [editingGroupID, setEditingGroupID] = createSignal<string>()
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame: number | undefined
  const layoutEntries = new Map<string, { type: "tab"; key: string } | { type: "group"; id: string }>()

  const tabIds = () => props.tabs.map(tabKey)
  const dragIds = createMemo(() => tabGroupDragLayout(props.tabs, tabs.groups))
  const entries = createMemo(() =>
    tabGroupLayout(props.tabs, tabs.groups).map((entry) => {
      const key = entry.type === "tab" ? `tab:${tabKey(entry.tab)}` : `group:${entry.group.id}`
      const current = layoutEntries.get(key)
      if (current) return current
      const next =
        entry.type === "tab"
          ? { type: "tab" as const, key: tabKey(entry.tab) }
          : { type: "group" as const, id: entry.group.id }
      layoutEntries.set(key, next)
      return next
    }),
  )

  const renderTab = (tab: Tab, hidden = () => false) => {
    const id = tabKey(tab)
    const index = () => dragIds().indexOf(id)
    const shortcutIndex = () => props.tabs.findIndex((item) => tabKey(item) === id)
    const serverCtx = createMemo(() => {
      if (tab.type !== "session") return
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
      if (conn) return global.ensureServerCtx(conn)
    })

    if (tab.type === "session") {
      return (
        <SessionTabSlot
          tab={tab}
          id={id}
          index={index}
          shortcutIndex={shortcutIndex}
          active={() => props.currentTab() === tab}
          forceTruncate={props.forceTruncate}
          serverCtx={serverCtx}
          hidden={hidden()}
          onEditGroup={setEditingGroupID}
          onNavigate={(element) => props.onNavigate(tab, element)}
          onClose={() => props.onClose(tab)}
        />
      )
    }

    return (
      <DraftTabSlot
        tab={tab}
        id={id}
        index={index}
        shortcutIndex={shortcutIndex}
        active={() => props.currentTab() === tab}
        title={language.t("tab.desktop")}
        hidden={hidden()}
        onEditGroup={setEditingGroupID}
        onNavigate={(element) => props.onNavigate(tab, element)}
        onClose={() => props.onClose(tab)}
      />
    )
  }

  function refreshOverflow() {
    if (!scrollRef) return
    props.onOverflowChange(scrollRef.scrollWidth > scrollRef.clientWidth)
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        refreshOverflow()
      })
    },
  )

  onMount(() => {
    refreshOverflow()
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    tabIds()
    refreshOverflow()
  })

  return (
    <div data-slot="titlebar-tabs" class="relative min-w-0">
      <div
        data-slot="titlebar-tabs-scroll"
        class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
        ref={scrollRef}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                !canStartTabDrag(event.pointerType) ||
                isTabCloseTarget(event.target) ||
                (event.target instanceof Element &&
                  !!event.target.closest('[contenteditable="true"],[data-titlebar-tab-group-editor]')),
            }),
          ]}
          modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => listRef })]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source
            if (!source) return
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())
            if (!tab) return
            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragEnd={(event) => {
            const current = dragIds()
            const source = event.operation.source
            if (event.canceled || !isSortable(source)) return

            const { initialIndex, index } = source
            if (initialIndex !== index) {
              const reordered = arrayMove(current, source.initialIndex, source.index)
              const group = tabs.groups.find((group) => tabGroupDragKey(group.id) === source.id.toString())
              if (group) {
                tabs.moveGroup(group.id, reordered)
                return
              }
              const groupKeys = new Set(tabs.groups.map((group) => tabGroupDragKey(group.id)))
              props.onReorder(
                reordered.filter((id) => !groupKeys.has(id)),
                source.id.toString(),
                reordered,
              )
            }
          }}
        >
          <div data-titlebar-tab-list class="flex w-full min-w-0 flex-row items-center" ref={listRef}>
            <For each={entries()}>
              {(entry) => {
                if (entry.type === "tab") {
                  const tab = props.tabs.find((tab) => tabKey(tab) === entry.key)
                  return tab ? renderTab(tab) : undefined
                }

                const group = createMemo(() => tabs.groups.find((group) => group.id === entry.id))
                const members = createMemo(() => {
                  const current = group()
                  if (!current) return []
                  const keys = new Set(current.tabs.map(tabKey))
                  return props.tabs.filter((tab) => keys.has(tabKey(tab)))
                })

                return (
                  <Show when={group()}>
                    {(current) => (
                      <div
                        data-titlebar-tab-group
                        data-group-id={current().id}
                        data-collapsed={current().collapsed}
                        class="flex min-w-0 shrink items-center"
                        style={tabGroupStyle(current())}
                      >
                        <TitlebarTabGroupHeader
                          group={current()}
                          index={() => dragIds().indexOf(tabGroupDragKey(current().id))}
                          editing={editingGroupID() === current().id}
                          onToggle={() => props.onToggleGroup(current().id)}
                          onEditingChange={(editing) => setEditingGroupID(editing ? current().id : undefined)}
                        />
                        <For each={members()}>{(tab) => renderTab(tab, () => current().collapsed)}</For>
                      </div>
                    )}
                  </Show>
                )
              }}
            </For>
          </div>
        </DragDropProvider>
      </div>
      <div
        data-slot="titlebar-tabs-fade-left"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
      />
      <div
        data-slot="titlebar-tabs-fade-right"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
      />
    </div>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1
    if (number < 1 || number > 9) return []
    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
