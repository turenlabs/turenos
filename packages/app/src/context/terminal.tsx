import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@turenlabs/ui/context"
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK, type DirectorySDK } from "./sdk"
import type { Platform } from "./platform"
import { useServerSDK } from "./server-sdk"
import { base64Encode } from "@turenlabs/core/util/encode"
import { defaultTitle, titleNumber } from "./terminal-title"
import { Persist, persisted, removePersisted, updatePersisted } from "@/utils/persist"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  command?: string
  args?: string[]
  env?: Record<string, string>
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
  shared?: boolean
  sessionID?: string
  workspaceID?: string
}

export type NewTerminalOptions = {
  focus?: boolean
  command?: string
  args?: string[]
  title?: string
  env?: Record<string, string>
}

export function replaceTerminalEntry(all: readonly LocalPTY[], id: string, next: LocalPTY) {
  const withoutNext = all.filter((pty) => pty.id !== next.id)
  const index = withoutNext.findIndex((pty) => pty.id === id)
  if (index === -1) return [...withoutNext, next]
  return withoutNext.map((pty, current) => (current === index ? next : pty))
}

// A session owns at most one shared terminal server-side. When the binding
// moves to a fresh PTY (shell exit, server restart, session move) the stale
// entries left for that session collapse into the new one in place instead of
// stacking dead tabs.
export function upsertSharedTerminal(all: readonly LocalPTY[], next: LocalPTY) {
  const matches = (pty: LocalPTY) =>
    pty.id === next.id || (pty.shared === true && next.sessionID !== undefined && pty.sessionID === next.sessionID)
  let placed = false
  const result = all.flatMap((pty) => {
    if (!matches(pty)) return [pty]
    if (placed) return []
    placed = true
    return [next]
  })
  if (!placed) result.push(next)
  return result
}

export function coalesceTerminalRequest<T>(requests: Map<string, Promise<T>>, key: string, create: () => Promise<T>) {
  const existing = requests.get(key)
  if (existing) return existing

  const request = create()
  requests.set(key, request)
  const clear = () => {
    if (requests.get(key) === request) requests.delete(key)
  }
  void request.then(clear, clear)
  return request
}

export function reconcileTerminalState(
  state: { active?: string; all: readonly LocalPTY[] },
  candidates: readonly string[],
  live: readonly string[],
) {
  const candidateIDs = new Set(candidates)
  const liveIDs = new Set(live)
  const all = state.all.filter((pty) => !candidateIDs.has(pty.id) || liveIDs.has(pty.id))
  const active = state.active && all.some((pty) => pty.id === state.active) ? state.active : all[0]?.id
  return { active, all }
}

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

// Shell seam for the nav rail's Agents-panel auto-collapse: every terminal
// focus request (tab click, terminal toggle command, new-terminal focus, the
// embedded terminal panel) flows through requestFocus below. Terminal workspaces are
// created per directory inside per-route TerminalProvider instances, so the
// subscription lives at module level where the shell — mounted above every
// provider instance — can hear all of them.
const terminalFocusListeners = new Set<() => void>()

export function onTerminalFocusRequest(listener: () => void): () => void {
  terminalFocusListeners.add(listener)
  return () => {
    terminalFocusListeners.delete(listener)
  }
}

export function notifyTerminalFocusRequest() {
  for (const listener of [...terminalFocusListeners]) {
    try {
      listener()
    } catch (error) {
      console.error("terminal focus listener failed", error)
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function strings(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return
  return [...value]
}

function stringRecord(value: unknown) {
  if (!record(value)) return
  const entries = Object.entries(value)
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return
  return Object.fromEntries(entries)
}

function numberFromTitle(title: string) {
  return titleNumber(title, MAX_TERMINAL_SESSIONS)
}

function pty(value: unknown): LocalPTY | undefined {
  if (!record(value)) return

  const id = text(value.id)
  if (!id) return

  const title = text(value.title) ?? ""
  const number = num(value.titleNumber)
  const command = text(value.command)
  const args = strings(value.args)
  const env = stringRecord(value.env)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = text(value.buffer)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)
  const shared = typeof value.shared === "boolean" ? value.shared : undefined
  const sessionID = text(value.sessionID)
  const workspaceID = text(value.workspaceID)

  return {
    id,
    title,
    titleNumber: number && number > 0 ? number : (numberFromTitle(title) ?? 0),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(!shared && buffer !== undefined ? { buffer } : {}),
    ...(!shared && scrollY !== undefined ? { scrollY } : {}),
    ...(!shared && cursor !== undefined ? { cursor } : {}),
    ...(shared !== undefined ? { shared } : {}),
    ...(sessionID !== undefined ? { sessionID } : {}),
    ...(workspaceID !== undefined ? { workspaceID } : {}),
  }
}

export function migrateTerminalState(value: unknown) {
  if (!record(value)) return value

  const seen = new Set<string>()
  const all = (Array.isArray(value.all) ? value.all : []).flatMap((item) => {
    const next = pty(item)
    if (!next || seen.has(next.id)) return []
    seen.add(next.id)
    return [next]
  })

  // A session owns at most one shared terminal server-side, but persisted state
  // can hold several stale entries for it. Keep the most recently appended.
  const latestShared = new Map(
    all.flatMap((item, index) => (item.shared && item.sessionID ? ([[item.sessionID, index]] as const) : [])),
  )
  const deduped = all.filter(
    (item, index) => !item.shared || !item.sessionID || latestShared.get(item.sessionID) === index,
  )
  const kept = new Set(deduped.map((item) => item.id))

  const active = text(value.active)
  // A dropped duplicate keeps the session's surviving shared tab active.
  const dropped = active && !kept.has(active) ? all.find((item) => item.id === active) : undefined
  const carried = deduped.find(
    (item) => item.shared && item.sessionID !== undefined && item.sessionID === dropped?.sessionID,
  )?.id

  return {
    active: (active && kept.has(active) ? active : carried) ?? deduped[0]?.id,
    all: deduped,
  }
}

export function getWorkspaceTerminalCacheKey(dir: string, scope: ServerScopeValue = ServerScope.local) {
  return ScopedKey.from(scope, dir, WORKSPACE_KEY)
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, TerminalCacheEntry>>()

const trimTerminal = (pty: LocalPTY) => {
  if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return pty
  return {
    ...pty,
    buffer: undefined,
    cursor: undefined,
    scrollY: undefined,
  }
}

function terminalPersistTarget(scope: ServerScopeValue, dir: string, legacy?: string[]) {
  return Persist.serverWorkspace(scope, dir, "terminal", legacy)
}

export function clearWorkspaceTerminals(
  dir: string,
  sessionIDs?: string[],
  platform?: Platform,
  scope: ServerScopeValue = ServerScope.local,
) {
  const key = getWorkspaceTerminalCacheKey(dir, scope)
  for (const cache of caches) {
    const entry = cache.get(key)
    entry?.value.clear()
  }

  void removePersisted(terminalPersistTarget(scope, dir), platform)

  if (scope !== ServerScope.local) return
  const legacy = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) {
    for (const key of getLegacyTerminalStorageKeys(dir, id)) {
      legacy.add(key)
    }
  }
  for (const key of legacy) {
    void removePersisted({ key }, platform)
  }
}

// Drops the given PTY ids from a persisted terminal state value, fixing up the
// active id like removeExited does. Returns undefined when nothing changed so
// callers can skip the storage write.
export function pruneTerminalStateEntries(value: unknown, ptyIDs: ReadonlySet<string>) {
  const state = migrateTerminalState(value)
  if (!record(state) || !Array.isArray(state.all)) return
  const all = state.all.filter(
    (pty): pty is LocalPTY => record(pty) && typeof pty.id === "string" && !ptyIDs.has(pty.id),
  )
  if (all.length === state.all.length) return
  const active =
    typeof state.active === "string" && all.some((pty) => pty.id === state.active) ? state.active : all[0]?.id
  return { active, all }
}

// Removes specific PTY entries from a workspace terminal store, for callers
// outside the TerminalProvider (workspace cleanup disposes the PTY server
// side after the provider unmounted, so pty.exited never prunes the entry and
// the next open would adopt a dead PTY). Takes the raw workspace directory;
// the provider keys its stores by the base64-encoded form.
export function removeWorkspaceTerminalEntries(input: {
  directory: string
  ptyIDs: readonly string[]
  platform?: Platform
  scope?: ServerScopeValue
}) {
  const ids = new Set(input.ptyIDs.filter((id) => !!id))
  if (ids.size === 0) return
  const scope = input.scope ?? ServerScope.local
  const dir = base64Encode(input.directory)
  const key = getWorkspaceTerminalCacheKey(dir, scope)

  // A live session owns the persisted key: mutate through it so the reactive
  // store and its persistence stay in sync (a raw storage write would be
  // clobbered by the live store's next write).
  let live = false
  for (const cache of caches) {
    const entry = cache.get(key)
    if (!entry) continue
    live = true
    for (const id of ids) entry.value.remove(id)
  }
  if (live) return

  void updatePersisted(terminalPersistTarget(scope, dir), input.platform, (value) =>
    pruneTerminalStateEntries(value, ids),
  )
}

function createWorkspaceTerminalSession(
  sdk: DirectorySDK,
  dir: string,
  scope: ServerScopeValue,
  legacySessionID?: string,
) {
  const legacy = scope === ServerScope.local ? getLegacyTerminalStorageKeys(dir, legacySessionID) : []

  const [store, setStore, _, ready] = persisted(
    {
      ...terminalPersistTarget(scope, dir, legacy),
      migrate: migrateTerminalState,
    },
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )
  const [ui, setUi] = createStore({
    focus: undefined as { request: number; id?: string; pending: boolean } | undefined,
  })
  const focus = { request: 0 }
  const sharedRequests = new Map<string, Promise<LocalPTY | undefined>>()
  let reconciled = false

  const requestFocus = (id?: string, pending = false) => {
    focus.request += 1
    setUi("focus", { request: focus.request, id, pending })
    notifyTerminalFocusRequest()
    return focus.request
  }

  const focusRequested = (id?: string) => {
    if (!id) return false
    if (!ui.focus || ui.focus.pending) return false
    return !ui.focus.id || ui.focus.id === id
  }

  const consumeFocus = (id: string) => {
    if (!focusRequested(id)) return
    setUi("focus", undefined)
  }

  const cancelFocus = (request?: number) => {
    if (request !== undefined && ui.focus?.request !== request) return
    setUi("focus", undefined)
  }

  if (typeof document !== "undefined") {
    const cancelOnOutsideFocus = (event: FocusEvent) => {
      if (!ui.focus) return
      if (!(event.target instanceof Element)) return
      if (event.target.closest("#terminal-panel")) return
      cancelFocus()
    }
    document.addEventListener("focusin", cancelOnOutsideFocus)
    onCleanup(() => document.removeEventListener("focusin", cancelOnOutsideFocus))
  }

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = new Set(
      store.all.flatMap((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return [direct]
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
        (number) => !existingTitleNumbers.has(number),
      ) ?? 1
    )
  }

  const removeExited = (id: string) => {
    const all = store.all
    const index = all.findIndex((x) => x.id === id)
    if (index === -1) return
    const active = store.active === id ? (index === 0 ? all[1]?.id : all[0]?.id) : store.active
    batch(() => {
      setStore("active", active)
      setStore(
        "all",
        produce((draft) => {
          draft.splice(index, 1)
        }),
      )
    })
  }

  // PTYs reported gone server-side (exit or delete) can never come back, so a
  // late shared()/adopt() resolution must not resurrect them as dead tabs.
  const gone = new Set<string>()
  const dropGone = (id: string) => {
    gone.add(id)
    removeExited(id)
  }
  const unsubExited = sdk.event.on("pty.exited", (event: { properties: { id: string } }) => {
    dropGone(event.properties.id)
  })
  const unsubDeleted = sdk.event.on("pty.deleted", (event: { properties: { id: string } }) => {
    dropGone(event.properties.id)
  })
  onCleanup(unsubExited)
  onCleanup(unsubDeleted)

  createEffect(() => {
    if (!ready() || reconciled) return
    reconciled = true
    const candidates = store.all.map((pty) => pty.id)
    void sdk.client.pty
      .list()
      .then((response) => {
        const privateIDs = (response.data ?? []).map((pty) => pty.id)
        const sharedIDs = store.all.flatMap((pty) => (pty.shared ? [pty.id] : []))
        const next = reconcileTerminalState(store, candidates, [...privateIDs, ...sharedIDs])
        if (next.all.length === store.all.length && next.active === store.active) return
        batch(() => {
          setStore("all", next.all)
          setStore("active", next.active)
        })
      })
      .catch((error: unknown) => {
        console.error("Failed to reconcile terminals", error)
      })
  })

  const update = (client: DirectorySDK["client"], pty: Partial<LocalPTY> & { id: string }) => {
    const index = store.all.findIndex((x) => x.id === pty.id)
    const previous = index >= 0 ? store.all[index] : undefined
    const shared = previous?.shared === true
    if (index >= 0) {
      setStore("all", index, (item) => ({
        ...item,
        ...pty,
        ...(shared ? { buffer: undefined, cursor: undefined, scrollY: undefined } : {}),
      }))
    }
    ;(shared
      ? client.v2.pty.update({
          ptyID: pty.id,
          location: { directory: sdk.directory, workspace: previous.workspaceID },
          title: pty.title,
          size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
        })
      : client.pty.update({
          ptyID: pty.id,
          title: pty.title,
          size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
        })
    ).catch((error: unknown) => {
      if (previous) {
        const currentIndex = store.all.findIndex((item) => item.id === pty.id)
        if (currentIndex >= 0) setStore("all", currentIndex, previous)
      }
      console.error("Failed to update terminal", error)
    })
  }

  const clone = async (client: DirectorySDK["client"], id: string) => {
    const index = store.all.findIndex((x) => x.id === id)
    const pty = store.all[index]
    if (!pty) return
    const next = await client.pty
      .create({
        title: pty.title,
        command: pty.command,
        args: pty.args,
        env: pty.env,
      })
      .catch((error: unknown) => {
        console.error("Failed to clone terminal", error)
        return undefined
      })
    if (!next?.data) return

    const active = store.active === pty.id

    batch(() => {
      setStore("all", index, {
        id: next.data.id,
        title: next.data.title ?? pty.title,
        titleNumber: pty.titleNumber,
        command: pty.command ?? next.data.command,
        args: pty.args ?? next.data.args,
        env: pty.env,
        buffer: undefined,
        cursor: undefined,
        scrollY: undefined,
        rows: undefined,
        cols: undefined,
      })
      if (active) {
        setStore("active", next.data.id)
      }
    })
  }

  return {
    ready,
    all: createMemo(() => store.all),
    active: createMemo(() => store.active),
    clear() {
      batch(() => {
        setStore("active", undefined)
        setStore("all", [])
      })
    },
    // Store-only removal (no server call), for teardown paths that already
    // disposed the PTY server-side and only need the stale entry pruned.
    remove(id: string) {
      removeExited(id)
    },
    // Store-only insertion for a PTY that already exists server-side: a
    // remounted terminal page reusing another instance's in-flight launch must
    // surface that PTY in ITS workspace store (the creating instance's store
    // was disposed with its provider). Idempotent per id.
    adopt(pty: LocalPTY) {
      if (gone.has(pty.id)) return
      const index = store.all.findIndex((x) => x.id === pty.id)
      batch(() => {
        if (index === -1) setStore("all", store.all.length, { ...pty })
        setStore("active", pty.id)
      })
    },
    async shared(sessionID: string, options?: { focus?: boolean }) {
      const request = coalesceTerminalRequest(sharedRequests, sessionID, async () => {
        const response = await sdk.client.v2.session.terminal.create({ sessionID })
        const state = response.data?.data
        if (!state) return
        // The binding may have exited between the server response and its
        // delivery here — adopting it would surface a dead tab.
        if (gone.has(state.ptyID)) return
        const existing = store.all.find((pty) => pty.id === state.ptyID)
        const next = existing
          ? { ...existing, shared: true, sessionID, workspaceID: state.workspaceID }
          : {
              id: state.ptyID,
              title: state.info.title,
              titleNumber: 0,
              command: state.info.command,
              args: state.info.args,
              shared: true,
              sessionID,
              workspaceID: state.workspaceID,
            }
        batch(() => {
          setStore("all", (all) => upsertSharedTerminal(all, next))
          setStore("active", state.ptyID)
        })
        return next
      }).catch((error: unknown) => {
        console.error("Failed to create shared terminal", error)
        return undefined
      })
      const next = await request
      if (options?.focus && next) requestFocus(next.id)
      return next
    },
    new(options?: NewTerminalOptions) {
      const nextNumber = pickNextTerminalNumber()
      const focusRequest = options?.focus ? requestFocus(undefined, true) : undefined

      return sdk.client.pty
        .create({
          title: options?.title ?? defaultTitle(nextNumber),
          command: options?.command,
          args: options?.args,
          env: options?.env,
        })
        .then((pty) => {
          const id = pty.data?.id
          if (!id) {
            if (focusRequest !== undefined) cancelFocus(focusRequest)
            return
          }
          const newTerminal = {
            id,
            title: pty.data?.title ?? defaultTitle(nextNumber),
            titleNumber: nextNumber,
            command: options?.command ?? pty.data?.command,
            args: options?.args ?? pty.data?.args,
            env: options?.env,
          }
          batch(() => {
            setStore("all", store.all.length, newTerminal)
            setStore("active", id)
            if (focusRequest !== undefined && ui.focus?.request === focusRequest) {
              setUi("focus", { request: focusRequest, id, pending: false })
            }
          })
          return newTerminal
        })
        .catch((error: unknown) => {
          if (focusRequest !== undefined) cancelFocus(focusRequest)
          console.error("Failed to create terminal", error)
        })
    },
    async replace(id: string, options?: NewTerminalOptions) {
      const previous = store.all.find((pty) => pty.id === id)
      const nextNumber = previous?.titleNumber ?? pickNextTerminalNumber()
      const focusRequest = options?.focus ? requestFocus(undefined, true) : undefined
      const response = await sdk.client.pty
        .create({
          title: options?.title ?? previous?.title ?? defaultTitle(nextNumber),
          command: options?.command ?? previous?.command,
          args: options?.args ?? previous?.args,
          env: options?.env ?? previous?.env,
        })
        .catch((error: unknown) => {
          if (focusRequest !== undefined) cancelFocus(focusRequest)
          console.error("Failed to replace terminal", error)
          return undefined
        })
      const nextID = response?.data?.id
      if (!nextID) {
        if (focusRequest !== undefined) cancelFocus(focusRequest)
        return
      }

      const next = {
        id: nextID,
        title: response.data?.title ?? options?.title ?? previous?.title ?? defaultTitle(nextNumber),
        titleNumber: nextNumber,
        command: options?.command ?? previous?.command ?? response.data?.command,
        args: options?.args ?? previous?.args ?? response.data?.args,
        env: options?.env ?? previous?.env,
      }
      batch(() => {
        setStore("all", (all) => replaceTerminalEntry(all, id, next))
        setStore("active", next.id)
        if (focusRequest !== undefined && ui.focus?.request === focusRequest) {
          setUi("focus", { request: focusRequest, id: next.id, pending: false })
        }
      })

      void sdk.client.pty.remove({ ptyID: id }).catch((error: unknown) => {
        console.error("Failed to retire replaced terminal", error)
      })
      return next
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      update(sdk.client, pty)
    },
    trim(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      if (index === -1) return
      setStore("all", index, (pty) => trimTerminal(pty))
    },
    trimAll() {
      setStore("all", (all) => {
        const next = all.map(trimTerminal)
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
    async clone(id: string) {
      await clone(sdk.client, id)
    },
    bind() {
      const client = sdk.client
      return {
        trim(id: string) {
          const index = store.all.findIndex((x) => x.id === id)
          if (index === -1) return
          setStore("all", index, (pty) => trimTerminal(pty))
        },
        update(pty: Partial<LocalPTY> & { id: string }) {
          update(client, pty)
        },
        async clone(id: string) {
          await clone(client, id)
        },
      }
    },
    open(id: string) {
      setStore("active", id)
    },
    requestFocus(id?: string) {
      requestFocus(id)
    },
    focusRequested(id?: string) {
      return focusRequested(id)
    },
    consumeFocus(id: string) {
      consumeFocus(id)
    },
    cancelFocus() {
      cancelFocus()
    },
    next() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    async close(id: string) {
      const index = store.all.findIndex((f) => f.id === id)
      const closed = store.all[index]
      if (index !== -1) {
        batch(() => {
          if (store.active === id) {
            const next = index > 0 ? store.all[index - 1]?.id : store.all[1]?.id
            setStore("active", next)
          }
          setStore(
            "all",
            produce((all) => {
              all.splice(index, 1)
            }),
          )
        })
      }

      const sessionID = closed?.sessionID
      const removed = await (
        closed?.shared && sessionID
          ? sdk.client.v2.session.terminal.remove({ sessionID })
          : sdk.client.pty.remove({ ptyID: id })
      )
        .then(() => true)
        .catch((error: unknown) => {
          console.error("Failed to close terminal", error)
          return false
        })
      if (removed || !closed) return
      batch(() => {
        setStore("all", (all) => {
          // A shared()/adopt() call may have re-added this id while the remove
          // request was in flight — re-inserting would duplicate the tab.
          if (all.some((pty) => pty.id === closed.id)) return all
          const next = [...all]
          next.splice(Math.min(index, next.length), 0, closed)
          return next
        })
        setStore("active", closed.id)
      })
    },
    move(id: string, to: number) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()
    const scope = () => serverSDK().scope
    const directory = createMemo(() => base64Encode(sdk().directory))

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, legacySessionID: string | undefined, serverScope: ServerScopeValue) => {
      // Terminals are workspace-scoped so tabs persist while switching sessions in the same directory.
      const key = getWorkspaceTerminalCacheKey(dir, serverScope)
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(sdk(), dir, serverScope, legacySessionID),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => loadWorkspace(directory(), params.id, scope()))

    createEffect(
      on(
        () => ({ dir: directory(), id: params.id, scope: scope() }),
        (next, prev) => {
          if (!prev?.dir) return
          if (next.dir === prev.dir && next.id === prev.id && next.scope === prev.scope) return
          if (next.dir === prev.dir && next.id && next.scope === prev.scope) return
          loadWorkspace(prev.dir, prev.id, prev.scope).trimAll()
        },
        { defer: true },
      ),
    )

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      active: () => workspace().active(),
      new: (options?: NewTerminalOptions) => workspace().new(options),
      shared: (sessionID: string, options?: { focus?: boolean }) => workspace().shared(sessionID, options),
      remove: (id: string) => workspace().remove(id),
      adopt: (pty: LocalPTY) => workspace().adopt(pty),
      replace: (id: string, options?: NewTerminalOptions) => workspace().replace(id, options),
      update: (pty: Partial<LocalPTY> & { id: string }) => workspace().update(pty),
      trim: (id: string) => workspace().trim(id),
      trimAll: () => workspace().trimAll(),
      clone: (id: string) => workspace().clone(id),
      bind: () => workspace(),
      open: (id: string) => workspace().open(id),
      requestFocus: (id?: string) => workspace().requestFocus(id),
      focusRequested: (id?: string) => workspace().focusRequested(id),
      consumeFocus: (id: string) => workspace().consumeFocus(id),
      cancelFocus: () => workspace().cancelFocus(),
      close: (id: string) => workspace().close(id),
      move: (id: string, to: number) => workspace().move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
