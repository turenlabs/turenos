import type { SessionReplayEntry, SessionReplayEvent, SessionReplaySearchResponse } from "@turenlabs/sdk/v2/client"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useAgentsPanel } from "@/components/agents-panel-state"
import { PageHeader } from "@/components/page-header"
import { toLegacySummary } from "@/context/global-sync/home-session-index"
import { ServerConnection } from "@/context/server"
import { showToast } from "@/utils/toast"
import {
  mergeReplayEvents,
  replayDelta,
  replayDuration,
  replayDurations,
  replayEventLabel,
  replayEventPreview,
  replayEventSequence,
  replayEventTimestamp,
  replayEventTone,
  replayLaneIndexes,
  replayLaneLabel,
  replayMatchPreview,
  replayPayload,
  replayStats,
} from "./session-replay-model"

const PAGE_SIZE = 100
const SPEEDS = [0.5, 1, 2, 8] as const
const LANE_TONES = [
  "bg-v2-text-text-accent",
  "bg-v2-state-fg-info",
  "bg-v2-state-fg-success",
  "bg-v2-state-fg-warning",
  "bg-v2-icon-icon-base",
]
const time = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
})
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
})

export default function SessionReplayPage() {
  const panel = useAgentsPanel()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<SessionReplayEntry["session"]>()
  const [cursor, setCursor] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const [view, setView] = createStore({ inspector: true, exporting: false })
  const [search, setSearch] = createStore({
    entries: [] as SessionReplayEntry[],
    total: 0,
    nextCursor: undefined as string | undefined,
    query: "",
    index: undefined as SessionReplaySearchResponse["index"] | undefined,
    loading: false,
    error: undefined as string | undefined,
  })
  const [history, setHistory] = createStore({
    events: [] as SessionReplayEvent[],
    previousCursor: undefined as string | undefined,
    nextCursor: undefined as string | undefined,
    loading: false,
    error: undefined as string | undefined,
  })
  let searchAbort: AbortController | undefined
  let historyAbort: AbortController | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let historyServer: string | undefined
  let queryEl: HTMLInputElement | undefined

  const runSearch = (append = false) => {
    searchAbort?.abort()
    const ctx = panel.focusedServerCtx()
    if (!ctx) {
      setSearch({
        entries: [],
        total: 0,
        nextCursor: undefined,
        query: "",
        index: undefined,
        loading: false,
        error: "Select a connected server.",
      })
      return
    }
    const requested = query().trim() || "is:session"
    if (append && search.query !== requested) {
      runSearch()
      return
    }
    const abort = new AbortController()
    searchAbort = abort
    const cursor = append ? search.nextCursor : undefined
    setSearch({ loading: true, error: undefined })
    void ctx.sdk.client.v2.session
      .replay(
        {
          query: requested,
          limit: String(PAGE_SIZE),
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal: abort.signal },
      )
      .then((response) => {
        if (abort.signal.aborted || !response.data) return
        setSearch({
          entries: append ? [...search.entries, ...response.data.data] : response.data.data,
          total: response.data.total,
          nextCursor: response.data.nextCursor,
          query: requested,
          index: response.data.index,
          loading: false,
          error: undefined,
        })
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setSearch({ loading: false, error: errorMessage(error) })
      })
  }

  createEffect(() => {
    panel.focusedServerCtx()
    query()
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => runSearch(), 250)
  })

  createEffect(() => {
    const conn = panel.focusedServer()
    const key = conn && panel.focusedServerCtx() ? ServerConnection.key(conn) : undefined
    if (historyServer === undefined) {
      historyServer = key
      return
    }
    if (historyServer === key) return
    historyServer = key
    searchAbort?.abort()
    historyAbort?.abort()
    setSelected(undefined)
    setPlaying(false)
    setSearch({
      entries: [],
      total: 0,
      nextCursor: undefined,
      query: "",
      index: undefined,
      loading: false,
      error: undefined,
    })
    setHistory({ events: [], previousCursor: undefined, nextCursor: undefined, loading: false, error: undefined })
  })

  createEffect(() => {
    if (search.index?.status !== "indexing" || search.loading) return
    const refresh = setTimeout(() => runSearch(), 2_000)
    onCleanup(() => clearTimeout(refresh))
  })

  const loadHistory = (session: SessionReplayEntry["session"], target?: string) => {
    const ctx = panel.focusedServerCtx()
    if (!ctx) return
    historyAbort?.abort()
    const abort = new AbortController()
    historyAbort = abort
    setSelected(session)
    setPlaying(false)
    setCursor(0)
    setHistory({ events: [], previousCursor: undefined, nextCursor: undefined, loading: true, error: undefined })

    void ctx.sdk.client.v2.session
      .replayHistory(
        { sessionID: session.id, limit: String(PAGE_SIZE), ...(target === undefined ? {} : { anchor: target }) },
        { signal: abort.signal },
      )
      .then((response) => {
        if (abort.signal.aborted || !response.data) return
        const targetIndex = target === undefined ? 0 : response.data.data.findIndex((event) => event.id === target)
        setHistory({
          events: response.data.data,
          previousCursor: response.data.cursor.previous,
          nextCursor: response.data.cursor.next,
          loading: false,
        })
        setCursor(Math.max(0, targetIndex))
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHistory({ loading: false, error: errorMessage(error) })
      })
  }

  const loadMoreHistory = (resume = false) => {
    const ctx = panel.focusedServerCtx()
    const session = selected()
    const next = history.nextCursor
    const abort = historyAbort
    if (!ctx || !session || !next || !abort || history.loading) return
    setHistory({ loading: true, error: undefined })
    void ctx.sdk.client.v2.session
      .replayHistory({ sessionID: session.id, limit: String(PAGE_SIZE), cursor: next }, { signal: abort.signal })
      .then((response) => {
        if (abort.signal.aborted || !response.data || selected()?.id !== session.id) return
        setHistory({
          events: mergeReplayEvents(history.events, response.data.data),
          nextCursor: response.data.cursor.next,
          loading: false,
        })
        if (resume) setPlaying(true)
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHistory({ loading: false, error: errorMessage(error) })
      })
  }

  const loadPreviousHistory = (move = false) => {
    const ctx = panel.focusedServerCtx()
    const session = selected()
    const previous = history.previousCursor
    const abort = historyAbort
    if (!ctx || !session || !previous || !abort || history.loading) return
    setHistory({ loading: true, error: undefined })
    void ctx.sdk.client.v2.session
      .replayHistory(
        { sessionID: session.id, limit: String(PAGE_SIZE), cursor: previous, direction: "before" },
        { signal: abort.signal },
      )
      .then((response) => {
        if (abort.signal.aborted || !response.data || selected()?.id !== session.id) return
        const added = response.data.data.filter(
          (event) => !history.events.some((current) => current.id === event.id),
        ).length
        setHistory({
          events: mergeReplayEvents(response.data.data, history.events),
          previousCursor: response.data.cursor.previous,
          loading: false,
        })
        setCursor((value) => Math.max(0, value + added - (move ? 1 : 0)))
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHistory({ loading: false, error: errorMessage(error) })
      })
  }

  const selectEntry = (entry: SessionReplayEntry) => loadHistory(entry.session, entry.event?.id)
  const current = createMemo(() => history.events[cursor()])
  const stats = createMemo(() => replayStats(history.events, cursor()))
  const lanes = createMemo(() => replayLaneIndexes(history.events))
  const durations = createMemo(() => replayDurations(history.events))
  const baseTime = createMemo(() => {
    const first = history.events[0]
    return first ? replayEventTimestamp(first) : 0
  })
  const groups = createMemo(() => {
    const map = new Map<string, { session: SessionReplayEntry["session"]; entries: SessionReplayEntry[] }>()
    for (const entry of search.entries) {
      const group = map.get(entry.session.id)
      if (group) group.entries.push(entry)
      else map.set(entry.session.id, { session: entry.session, entries: [entry] })
    }
    return [...map.values()]
  })
  const nextFailure = createMemo(() => {
    const ahead = history.events.findIndex((event, index) => index > cursor() && replayEventTone(event) === "danger")
    if (ahead >= 0) return ahead
    return history.events.findIndex((event) => replayEventTone(event) === "danger")
  })
  const atHead = createMemo(() => history.events.length > 0 && cursor() === history.events.length - 1)

  const togglePlay = () => {
    if (playing()) {
      setPlaying(false)
      return
    }
    if (cursor() >= history.events.length - 1 && history.nextCursor) {
      loadMoreHistory(true)
      return
    }
    if (cursor() >= history.events.length - 1) setCursor(0)
    setPlaying(true)
  }

  const stepForward = () => {
    setPlaying(false)
    if (cursor() >= history.events.length - 1 && history.nextCursor) {
      loadMoreHistory()
      return
    }
    setCursor((value) => Math.min(history.events.length - 1, value + 1))
  }

  const stepBack = () => {
    setPlaying(false)
    if (cursor() === 0 && history.previousCursor) {
      loadPreviousHistory(true)
      return
    }
    setCursor((value) => Math.max(0, value - 1))
  }

  const seek = (index: number) => {
    setPlaying(false)
    setCursor(Math.max(0, Math.min(history.events.length - 1, index)))
  }

  const exportTrace = () => {
    const ctx = panel.focusedServerCtx()
    const session = selected()
    if (!ctx || !session || view.exporting) return
    setView("exporting", true)
    const collect = async () => {
      const events: SessionReplayEvent[] = []
      let cursor: string | undefined
      do {
        const response = await ctx.sdk.client.v2.session.replayHistory(
          { sessionID: session.id, limit: String(PAGE_SIZE), ...(cursor === undefined ? {} : { cursor }) },
          { signal: historyAbort?.signal },
        )
        if (!response.data) break
        events.push(...response.data.data)
        cursor = response.data.cursor.next ?? undefined
      } while (cursor)
      return events
    }
    void collect()
      .then((events) => {
        const bundle = {
          format: "turenos-trace@1",
          exportedAt: new Date().toISOString(),
          session,
          events,
        }
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
        )
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = `trace-${session.id}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1_000)
        showToast({ title: `Exported ${events.length} events`, description: session.title, variant: "success" })
      })
      .catch((error: unknown) => showToast({ title: "Export failed", description: errorMessage(error) }))
      .finally(() => setView("exporting", false))
  }

  createEffect(() => {
    if (!playing()) return
    const interval = setInterval(
      () => {
        setCursor((value) => {
          if (value < history.events.length - 1) return value + 1
          if (history.nextCursor) loadMoreHistory(true)
          setPlaying(false)
          return value
        })
      },
      Math.max(70, 650 / speed()),
    )
    onCleanup(() => clearInterval(interval))
  })

  // Streaming windows: approaching either loaded boundary pulls the next page so
  // the scrubber never dead-ends on pagination.
  createEffect(() => {
    const position = cursor()
    const count = history.events.length
    if (!selected() || history.loading || count === 0) return
    if (position >= count - 12 && history.nextCursor) loadMoreHistory()
    if (position <= 12 && history.previousCursor) loadPreviousHistory()
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        if (event.key === "Escape") target.blur()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "/") {
        event.preventDefault()
        queryEl?.focus()
        queryEl?.select()
        return
      }
      if (!selected()) return
      if (event.key === " ") {
        event.preventDefault()
        togglePlay()
        return
      }
      if (event.key === "ArrowRight") {
        event.preventDefault()
        stepForward()
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        stepBack()
        return
      }
      if (event.key === "f" || event.key === "F") {
        if (nextFailure() >= 0) seek(nextFailure())
        return
      }
      if (event.key === "e" || event.key === "E") {
        exportTrace()
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  onCleanup(() => {
    if (debounce) clearTimeout(debounce)
    searchAbort?.abort()
    historyAbort?.abort()
  })

  return (
    <main
      data-component="session-replay"
      class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
    >
      <PageHeader
        title="Session Traces"
        description="Search every durable event, then replay the root and linked task streams."
      />

      <div class="shrink-0 border-b border-v2-border-border-subtle">
        <div class="flex h-11 items-center gap-3 px-4 sm:px-5">
          <IconV2 name="magnifying-glass" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <input
            ref={queryEl}
            value={query()}
            spellcheck={false}
            placeholder="has:error after:24h tool:bash"
            aria-label="Replay query"
            class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="hidden items-center gap-1.5 md:flex">
            <QueryChip value="has:error after:24h" onSelect={setQuery} />
            <QueryChip value="type:tool status:failed" onSelect={setQuery} />
            <QueryChip value="is:session" onSelect={setQuery} />
          </div>
          <details class="group relative shrink-0">
            <summary class="flex size-6 cursor-default list-none items-center justify-center rounded-[6px] text-v2-icon-icon-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base [&::-webkit-details-marker]:hidden">
              <IconV2 name="help" size="small" />
            </summary>
            <div class="absolute right-0 top-7 z-10 w-72 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-02 p-3">
              <p class="font-mono text-[10px] leading-4 text-v2-text-text-muted">
                text &middot; session: &middot; id: &middot; message: &middot; call: &middot; type: &middot; agent:
                &middot; model: &middot; tool: &middot; status: &middot; path: &middot; after: &middot; before:
                &middot; has:error &middot; is:session &middot; is:event
              </p>
              <p class="mt-2 text-[10px] leading-4 text-v2-text-text-faint">
                Quote spaces. Prefix a field with - to exclude it. Times accept ISO dates or 30m, 24h, 7d.
              </p>
              <p class="mt-2 border-t border-v2-border-border-subtle pt-2 font-mono text-[9px] leading-4 text-v2-text-text-faint">
                / focus query &middot; space play &middot; &larr;/&rarr; step &middot; f next failure &middot; e export
              </p>
            </div>
          </details>
          <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-v2-text-text-muted">
            {search.loading && search.entries.length === 0 ? "indexing" : `${search.total} matches`}
            <Show when={search.loading}>
              <span class="text-v2-text-text-accent"> &middot; searching</span>
            </Show>
          </span>
        </div>
        <Show when={search.index?.status === "indexing" && search.index} keyed>
          {(index) => (
            <div class="flex items-center gap-3 border-t border-v2-border-border-subtle px-4 py-1.5 sm:px-5">
              <span class="shrink-0 text-[9px] uppercase tracking-[0.12em] text-v2-text-text-muted">
                Warming history index
              </span>
              <div class="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-v2-background-bg-layer-02">
                <div
                  class="h-full rounded-full bg-v2-text-text-accent transition-[width] duration-300"
                  style={{ width: `${Math.max(1, index.progress * 100)}%` }}
                />
              </div>
              <span class="shrink-0 font-mono text-[9px] text-v2-text-text-muted">
                {Math.floor(index.progress * 100)}%
              </span>
            </div>
          )}
        </Show>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(220px,38%)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[272px_minmax(0,1fr)] lg:grid-rows-1">
        <aside class="flex min-h-0 flex-col border-b border-v2-border-border-subtle bg-v2-background-bg-layer-01 lg:border-b-0 lg:border-r">
          <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-subtle px-3 text-[9px] uppercase tracking-[0.14em] text-v2-text-text-muted">
            <span>Results</span>
            <Show when={search.query}>
              <span class="truncate font-mono normal-case tracking-normal text-v2-text-text-faint">{search.query}</span>
            </Show>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
            <Show when={search.error}>
              <div class="m-1.5 border border-v2-state-border-danger bg-v2-state-bg-danger p-3 text-[12px] text-v2-state-fg-danger">
                {search.error}
              </div>
            </Show>
            <Show when={!search.loading && search.entries.length === 0 && !search.error}>
              <p class="px-3 py-8 text-center text-[11px] text-v2-text-text-faint">No matches.</p>
            </Show>
            <For each={groups()}>
              {(group) => (
                <ResultGroup
                  group={group}
                  selectedSession={() => selected()?.id}
                  currentEvent={() => current()?.id}
                  onSelect={selectEntry}
                />
              )}
            </For>
            <Show when={search.nextCursor != null}>
              <button
                type="button"
                class="mt-1 h-8 w-full rounded-[7px] text-[11px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:ring-1 focus-visible:ring-v2-border-border-focus"
                disabled={search.loading}
                onClick={() => runSearch(true)}
              >
                {search.loading ? "Loading..." : `Load more of ${search.total}`}
              </button>
            </Show>
          </div>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-col">
          <Show
            when={selected()}
            fallback={
              <div class="flex h-full min-h-[360px] items-center justify-center p-8">
                <div class="w-full max-w-sm">
                  <p class="text-[10px] uppercase tracking-[0.15em] text-v2-text-text-accent">Flight recorder</p>
                  <h2 class="mt-2 text-[22px] tracking-[-0.025em] [font-weight:620]">Pick a trace to replay.</h2>
                  <p class="mt-2 text-[13px] leading-5 text-v2-text-text-muted">
                    Every durable event across the root session and linked task streams is searchable and replayable.
                  </p>
                  <div class="mt-5 space-y-1.5">
                    <For each={["has:error after:24h", "type:tool status:failed", "is:session"]}>
                      {(preset) => (
                        <button
                          type="button"
                          class="flex w-full items-center justify-between rounded-[8px] border border-v2-border-border-subtle px-3 py-2 text-left font-mono text-[11px] text-v2-text-text-muted outline-none transition-colors hover:border-v2-border-border-base hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:border-v2-border-border-focus"
                          onClick={() => setQuery(preset)}
                        >
                          <span>{preset}</span>
                          <span aria-hidden="true" class="text-v2-text-text-faint">
                            &rarr;
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                  <p class="mt-5 font-mono text-[10px] leading-4 text-v2-text-text-faint">
                    / focus query &middot; space play &middot; &larr;/&rarr; step &middot; f next failure &middot; e export
                  </p>
                </div>
              </div>
            }
          >
            {(session) => (
              <>
                <header class="flex flex-wrap items-center justify-between gap-3 border-b border-v2-border-border-subtle px-4 py-3 sm:px-5">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">
                      <span class="font-mono">{session().id}</span>
                      <span aria-hidden="true">/</span>
                      <span>
                        {history.loading ? `Loading ${history.events.length}` : `${history.events.length} loaded`}
                        {history.nextCursor ? "+" : ""}
                      </span>
                    </div>
                    <h2 class="mt-1 truncate text-[17px] [font-weight:620]">{session().title}</h2>
                    <p class="mt-0.5 truncate font-mono text-[10px] text-v2-text-text-faint">
                      {session().location.directory}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <ButtonV2
                      variant="outline"
                      size="normal"
                      icon="outline-share"
                      disabled={view.exporting}
                      onClick={exportTrace}
                    >
                      {view.exporting ? "Exporting..." : "Export"}
                    </ButtonV2>
                    <button
                      type="button"
                      aria-label="Toggle inspector"
                      title="Toggle inspector"
                      class="flex size-8 items-center justify-center rounded-[7px] border border-v2-border-border-base outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:border-v2-border-border-focus"
                      classList={{
                        "text-v2-icon-icon-base": view.inspector,
                        "text-v2-icon-icon-muted": !view.inspector,
                      }}
                      onClick={() => setView("inspector", !view.inspector)}
                    >
                      <IconV2 name="sidebar-right" size="small" />
                    </button>
                    <ButtonV2
                      variant="outline"
                      size="normal"
                      icon="outline-square-arrow"
                      onClick={() => panel.openSession(toLegacySummary(session()))}
                    >
                      Open session
                    </ButtonV2>
                  </div>
                </header>

                <EventTape
                  events={() => history.events}
                  cursor={cursor}
                  lanes={lanes}
                  hasMore={() => history.nextCursor != null}
                  onSeek={seek}
                />

                <Show when={history.error}>
                  <div class="border-b border-v2-state-border-danger bg-v2-state-bg-danger px-5 py-2 text-[12px] text-v2-state-fg-danger">
                    {history.error}
                  </div>
                </Show>

                <div
                  class="grid min-h-0 flex-1 grid-cols-1 overflow-hidden"
                  classList={{
                    "grid-rows-[minmax(260px,1fr)_minmax(280px,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] xl:grid-rows-1":
                      view.inspector,
                    "grid-rows-1 xl:grid-cols-1": !view.inspector,
                  }}
                >
                  <ReplayTimeline
                    events={() => history.events}
                    cursor={cursor}
                    lanes={lanes}
                    durations={durations}
                    base={baseTime}
                    onSelect={seek}
                  />
                  <Show when={view.inspector}>
                    <ReplayInspector
                      event={current}
                      stats={stats}
                      session={session}
                      durations={durations}
                    />
                  </Show>
                </div>

                <footer class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-v2-border-border-subtle bg-v2-background-bg-layer-01 px-4 py-2 sm:px-5">
                  <button
                    type="button"
                    title="Play / pause (space)"
                    class="flex h-8 min-w-16 items-center justify-center rounded-[7px] bg-v2-background-bg-inverse px-3 text-[12px] text-v2-text-text-inverse disabled:opacity-40"
                    disabled={history.events.length < 2 && !history.nextCursor}
                    onClick={togglePlay}
                  >
                    {playing()
                      ? "Pause"
                      : cursor() >= history.events.length - 1
                        ? history.nextCursor
                          ? "Continue"
                          : "Replay"
                        : "Play"}
                  </button>
                  <StepButton
                    label="Previous event"
                    direction="back"
                    disabled={cursor() === 0 && !history.previousCursor}
                    onClick={stepBack}
                  />
                  <StepButton
                    label="Next event"
                    direction="forward"
                    disabled={cursor() >= history.events.length - 1 && !history.nextCursor}
                    onClick={stepForward}
                  />
                  <button
                    type="button"
                    title="Jump to next failure (f)"
                    class="flex h-8 items-center gap-1.5 rounded-[7px] border border-v2-border-border-base px-2.5 text-[11px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-30 focus-visible:border-v2-border-border-focus"
                    disabled={nextFailure() < 0}
                    onClick={() => seek(nextFailure())}
                  >
                    <span class="size-1.5 rounded-full bg-v2-state-fg-danger" />
                    Failure
                  </button>
                  <div class="flex overflow-hidden rounded-[7px] border border-v2-border-border-base">
                    <For each={SPEEDS}>
                      {(option) => (
                        <button
                          type="button"
                          class="h-8 px-2 font-mono text-[10px] outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
                          classList={{
                            "bg-v2-background-bg-layer-02 text-v2-text-text-base": speed() === option,
                            "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base":
                              speed() !== option,
                          }}
                          onClick={() => setSpeed(option)}
                        >
                          {option}x
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="ml-auto flex items-center gap-3 font-mono text-[10px] text-v2-text-text-muted">
                    <Show when={current()} keyed>
                      {(event) => <span>{formatClock(replayEventTimestamp(event))}</span>}
                    </Show>
                    <span>
                      {history.events.length === 0 ? "0 / 0" : `${cursor() + 1} / ${history.events.length}`}
                      {history.nextCursor ? "+" : ""}
                    </span>
                    <Show when={atHead() && !history.nextCursor}>
                      <span class="rounded-full border border-v2-border-border-subtle px-1.5 py-px text-[8px] uppercase tracking-[0.12em] text-v2-text-text-faint">
                        head
                      </span>
                    </Show>
                  </div>
                </footer>
              </>
            )}
          </Show>
        </section>
      </div>
    </main>
  )
}

function QueryChip(props: { value: string; onSelect: (value: string) => void }) {
  return (
    <button
      type="button"
      class="rounded-full border border-v2-border-border-subtle px-2 py-1 font-mono text-[9px] text-v2-text-text-muted outline-none hover:border-v2-border-border-base hover:text-v2-text-text-base focus-visible:border-v2-border-border-focus"
      onClick={() => props.onSelect(props.value)}
    >
      {props.value}
    </button>
  )
}

function ResultGroup(props: {
  group: { session: SessionReplayEntry["session"]; entries: SessionReplayEntry[] }
  selectedSession: () => string | undefined
  currentEvent: () => string | undefined
  onSelect: (entry: SessionReplayEntry) => void
}) {
  const active = () => props.selectedSession() === props.group.session.id
  const updated = () => {
    const value = props.group.session.time.updated
    const timestamp = typeof value === "number" ? value : Date.parse(value)
    return Number.isNaN(timestamp) ? "" : time.format(timestamp)
  }
  return (
    <div class="mb-1">
      <button
        type="button"
        class="w-full rounded-[8px] border px-2.5 py-2 text-left outline-none transition-colors"
        classList={{
          "border-v2-border-border-focus bg-v2-background-bg-layer-02": active(),
          "border-transparent hover:border-v2-border-border-subtle hover:bg-v2-overlay-simple-overlay-hover":
            !active(),
        }}
        onClick={() => props.onSelect(props.group.entries[0])}
      >
        <div class="flex items-center justify-between gap-2">
          <span class="truncate text-[12px] [font-weight:570]">{props.group.session.title}</span>
          <span class="shrink-0 font-mono text-[9px] text-v2-text-text-faint">{updated()}</span>
        </div>
        <p class="mt-0.5 truncate text-[10px] text-v2-text-text-muted">{props.group.session.location.directory}</p>
      </button>
      <div class="ml-3 mt-0.5 space-y-0.5 border-l border-v2-border-border-subtle pl-1.5 pt-0.5">
        <For each={props.group.entries.filter((entry) => entry.event !== undefined)}>
          {(entry) => {
            const selected = () => active() && props.currentEvent() === entry.event?.id
            return (
              <button
                type="button"
                class="flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
                classList={{ "bg-v2-background-bg-layer-02": selected() }}
                onClick={() => props.onSelect(entry)}
              >
                <ToneDot tone={entry.event ? matchTone(entry.event.type) : "neutral"} class="mt-1" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-v2-text-text-accent">
                    <span class="truncate">{entry.event!.type.replace(/^session\.next\./, "")}</span>
                    <span class="shrink-0 text-v2-text-text-faint">#{entry.event!.seq}</span>
                  </span>
                  <span class="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-v2-text-text-muted">
                    {replayMatchPreview(entry.event!.preview)}
                  </span>
                </span>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}

function matchTone(type: string) {
  if (type.includes("failed")) return "danger" as const
  if (type.includes("tool")) return "tool" as const
  if (type.includes("prompt") || type.includes("text")) return "message" as const
  if (type.includes("step")) return "step" as const
  return "neutral" as const
}

function ToneDot(props: { tone: ReturnType<typeof matchTone>; class?: string }) {
  return (
    <span
      class={`size-2 shrink-0 rounded-full ${props.class ?? ""}`}
      classList={{
        "bg-v2-state-fg-danger": props.tone === "danger",
        "bg-v2-text-text-accent": props.tone === "tool",
        "bg-v2-state-fg-success": props.tone === "message",
        "bg-v2-icon-icon-base": props.tone === "step",
        "bg-v2-icon-icon-faint": props.tone === "neutral",
      }}
    />
  )
}

function StepButton(props: { label: string; direction: "back" | "forward"; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      class="flex size-8 items-center justify-center rounded-[7px] border border-v2-border-border-base text-v2-icon-icon-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base disabled:opacity-30 focus-visible:border-v2-border-border-focus"
      onClick={props.onClick}
    >
      <IconV2 name="chevron-down" size="small" class={props.direction === "back" ? "rotate-90" : "-rotate-90"} />
    </button>
  )
}

function EventTape(props: {
  events: () => SessionReplayEvent[]
  cursor: () => number
  lanes: () => Map<string, number>
  hasMore: () => boolean
  onSeek: (index: number) => void
}) {
  let strip: HTMLDivElement | undefined
  const count = () => props.events().length
  const pos = (index: number) => (count() <= 1 ? 0 : (index / (count() - 1)) * 100)
  const seek = (event: PointerEvent) => {
    if (!strip || count() === 0) return
    const rect = strip.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    props.onSeek(Math.round(fraction * (count() - 1)))
  }
  const first = () => props.events()[0]
  const last = () => props.events()[count() - 1]
  const legend = createMemo(() =>
    [...props.lanes().keys()].slice(0, 6).map((id) => ({ label: replayLaneLabel(id), index: props.lanes().get(id)! })),
  )
  return (
    <div class="shrink-0 border-b border-v2-border-border-subtle bg-v2-background-bg-base px-4 pb-1.5 pt-2 sm:px-5">
      <div
        ref={strip}
        role="slider"
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count() - 1)}
        aria-valuenow={props.cursor()}
        tabIndex={0}
        class="relative h-7 cursor-crosshair select-none outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-focus"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          seek(event)
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) seek(event)
        }}
      >
        <For each={props.events()}>
          {(event, index) => {
            const tone = replayEventTone(event)
            return (
              <span
                class="pointer-events-none absolute top-1/2 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${pos(index())}%`,
                  height: tone === "danger" ? "100%" : "55%",
                }}
                classList={{
                  "bg-v2-state-fg-danger": tone === "danger",
                  "bg-v2-text-text-accent": tone === "tool",
                  "bg-v2-state-fg-success": tone === "message",
                  "bg-v2-icon-icon-base": tone === "step",
                  "bg-v2-icon-icon-faint": tone === "neutral",
                  "opacity-30": index() > props.cursor(),
                }}
              />
            )
          }}
        </For>
        <Show when={count() > 0}>
          <span
            class="pointer-events-none absolute top-0 h-full w-[2px] -translate-x-1/2 bg-v2-text-text-base"
            style={{ left: `${pos(props.cursor())}%` }}
          />
          <span
            class="pointer-events-none absolute top-0 size-[5px] -translate-x-1/2 rounded-[1px] bg-v2-text-text-base"
            style={{ left: `${pos(props.cursor())}%` }}
          />
        </Show>
      </div>
      <div class="mt-1 flex items-center justify-between gap-3 font-mono text-[9px] text-v2-text-text-faint">
        <span class="shrink-0">{first() ? formatTimestamp(replayEventTimestamp(first())) : ""}</span>
        <span class="flex min-w-0 items-center gap-2.5 overflow-hidden">
          <For each={legend()}>
            {(lane) => (
              <span class="flex shrink-0 items-center gap-1">
                <span class={`size-1.5 rounded-full ${LANE_TONES[lane.index % LANE_TONES.length]}`} />
                {lane.label}
              </span>
            )}
          </For>
        </span>
        <span class="shrink-0">
          {last() ? `${formatTimestamp(replayEventTimestamp(last()))}${props.hasMore() ? " \u2026" : ""}` : ""}
        </span>
      </div>
    </div>
  )
}

function ReplayTimeline(props: {
  events: () => SessionReplayEvent[]
  cursor: () => number
  lanes: () => Map<string, number>
  durations: () => Map<string, number>
  base: () => number
  onSelect: (index: number) => void
}) {
  let scroller: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLButtonElement>({
    get count() {
      return props.events().length
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => 60,
    overscan: 12,
    get getItemKey() {
      return (index: number) => props.events()[index]?.id ?? index
    },
  })

  createEffect(() => {
    const index = props.cursor()
    if (!props.events()[index]) return
    queueMicrotask(() => virtualizer.scrollToIndex(index, { align: "auto" }))
  })

  return (
    <div class="flex min-h-0 flex-col border-b border-v2-border-border-subtle xl:border-b-0 xl:border-r">
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-v2-border-border-subtle px-4 text-[9px] uppercase tracking-[0.14em] text-v2-text-text-muted">
        <span>Durable timeline</span>
        <span>lane / seq</span>
      </div>
      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto">
        <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const event = () => props.events()[item.index]
              return (
                <button
                  type="button"
                  data-index={item.index}
                  ref={(element) => virtualizer.measureElement(element)}
                  class="absolute left-0 top-0 flex w-full items-start gap-3 border-b border-v2-border-border-subtle px-4 py-2 text-left outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
                  classList={{
                    "bg-v2-background-bg-layer-02": props.cursor() === item.index,
                    "opacity-40": item.index > props.cursor(),
                  }}
                  style={{ transform: `translateY(${item.start}px)` }}
                  onClick={() => props.onSelect(item.index)}
                >
                  <Show when={event()} keyed>
                    {(current) => {
                      const tone = () => replayEventTone(current)
                      const duration = () => props.durations().get(current.id)
                      const lane = () => props.lanes().get(current.durable.aggregateID) ?? 0
                      return (
                        <>
                          <span
                            class="mt-0.5 w-14 shrink-0 text-right font-mono text-[9px] leading-4 text-v2-text-text-faint"
                            title={formatTimestamp(replayEventTimestamp(current))}
                          >
                            {replayDelta(props.base(), replayEventTimestamp(current))}
                          </span>
                          <ToneDot tone={tone()} class="mt-1" />
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center justify-between gap-2">
                              <span
                                class="truncate font-mono text-[10px] leading-4"
                                classList={{
                                  "text-v2-state-fg-danger": tone() === "danger",
                                  "text-v2-text-text-base": tone() !== "danger",
                                }}
                              >
                                {replayEventLabel(current)}
                              </span>
                              <span class="flex shrink-0 items-center gap-1.5">
                                <Show when={duration() !== undefined}>
                                  <span class="rounded-[4px] bg-v2-background-bg-layer-01 px-1 py-px font-mono text-[8px] text-v2-text-text-muted">
                                    {replayDuration(duration()!)}
                                  </span>
                                </Show>
                                <span class="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.08em] text-v2-text-text-faint">
                                  <span class={`size-1.5 rounded-full ${LANE_TONES[lane() % LANE_TONES.length]}`} />
                                  {replayLaneLabel(current.durable.aggregateID)}
                                </span>
                                <span class="font-mono text-[9px] text-v2-text-text-faint">
                                  /{replayEventSequence(current)}
                                </span>
                              </span>
                            </span>
                            <span class="mt-0.5 block truncate text-[10px] leading-4 text-v2-text-text-muted">
                              {replayEventPreview(current)}
                            </span>
                          </span>
                        </>
                      )
                    }}
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

function ReplayInspector(props: {
  event: () => SessionReplayEvent | undefined
  stats: () => ReturnType<typeof replayStats>
  session: () => SessionReplayEntry["session"]
  durations: () => Map<string, number>
}) {
  const payload = createMemo(() => {
    const event = props.event()
    return event ? replayPayload(event) : { rows: [], blocks: [] }
  })
  return (
    <div class="flex min-h-0 flex-col bg-v2-background-bg-base">
      <div class="grid shrink-0 grid-cols-4 border-b border-v2-border-border-subtle bg-v2-background-bg-layer-01">
        <InspectorStat label="Events" value={props.stats().events} />
        <InspectorStat label="Turns" value={props.stats().turns} />
        <InspectorStat label="Tools" value={props.stats().tools} />
        <InspectorStat label="Failures" value={props.stats().failures} danger={props.stats().failures > 0} />
      </div>
      <Show
        when={props.event()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-[12px] text-v2-text-text-muted">
            No durable events.
          </div>
        }
      >
        {(event) => (
          <div class="min-h-0 flex-1 overflow-y-auto">
            <div class="border-b border-v2-border-border-subtle px-5 py-3">
              <div class="flex items-center justify-between gap-3">
                <h3 class="min-w-0 truncate font-mono text-[12px] text-v2-text-text-accent">{event().type}</h3>
                <div class="flex shrink-0 items-center gap-1.5">
                  <Show when={replayEventTone(event()) === "danger"}>
                    <span class="rounded-full border border-v2-state-border-danger px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-v2-state-fg-danger">
                      failed
                    </span>
                  </Show>
                  <span class="rounded-full border border-v2-border-border-subtle px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-v2-text-text-muted">
                    durable
                  </span>
                </div>
              </div>
            </div>
            <div class="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 border-b border-v2-border-border-subtle px-5 py-4 text-[11px] sm:grid-cols-3">
              <InspectorField
                label="Aggregate"
                value={`${replayLaneLabel(event().durable.aggregateID)} \u00b7 ${event().durable.aggregateID}`}
                mono
              />
              <InspectorField label="Sequence" value={`#${replayEventSequence(event())}`} mono />
              <InspectorField label="Event ID" value={event().id} mono />
              <InspectorField label="Recorded" value={formatTimestamp(replayEventTimestamp(event()))} />
              <InspectorField label="Version" value={String(event().durable.version)} mono />
              <Show when={props.durations().get(event().id) !== undefined}>
                <InspectorField label="Span" value={replayDuration(props.durations().get(event().id)!)} mono />
              </Show>
            </div>
            <Show when={payload().rows.length > 0}>
              <dl class="border-b border-v2-border-border-subtle px-5 py-3">
                <For each={payload().rows}>
                  {(row) => (
                    <div class="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-1 text-[11px]">
                      <dt class="truncate font-mono text-[10px] leading-4 text-v2-text-text-faint">{row.label}</dt>
                      <dd
                        class="truncate leading-4"
                        classList={{
                          "font-mono": row.mono,
                          "text-v2-state-fg-danger": row.danger,
                          "text-v2-text-text-base": !row.danger,
                        }}
                        title={row.value}
                      >
                        {row.value}
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </Show>
            <For each={payload().blocks}>
              {(block) => (
                <div class="border-b border-v2-border-border-subtle px-5 py-3">
                  <p class="text-[9px] uppercase tracking-[0.12em] text-v2-text-text-muted">{block.title}</p>
                  <pre
                    class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-v2-border-border-subtle bg-v2-background-bg-deep p-3 text-[11px] leading-5"
                    classList={{
                      "font-mono": block.mono,
                      "text-v2-state-fg-danger": block.danger,
                      "text-v2-text-text-base": !block.danger,
                    }}
                  >
                    {block.text}
                  </pre>
                </div>
              )}
            </For>
            <details class="group px-5 py-3">
              <summary class="cursor-default select-none text-[9px] uppercase tracking-[0.12em] text-v2-text-text-muted outline-none hover:text-v2-text-text-base [&::-webkit-details-marker]:hidden">
                Raw event
              </summary>
              <pre class="mt-2 min-w-full overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-v2-border-border-subtle bg-v2-background-bg-deep p-3 font-mono text-[10px] leading-5 text-v2-text-text-muted">
                {JSON.stringify(event(), null, 2)}
              </pre>
            </details>
          </div>
        )}
      </Show>
    </div>
  )
}

function InspectorStat(props: { label: string; value: number; danger?: boolean }) {
  return (
    <div class="border-r border-v2-border-border-subtle px-3 py-2.5 last:border-r-0">
      <p class="text-[9px] uppercase tracking-[0.1em] text-v2-text-text-muted">{props.label}</p>
      <p class="mt-0.5 font-mono text-[15px] [font-weight:600]" classList={{ "text-v2-state-fg-danger": props.danger }}>
        {props.value}
      </p>
    </div>
  )
}

function InspectorField(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div class="min-w-0">
      <p class="text-[9px] uppercase tracking-[0.1em] text-v2-text-text-muted">{props.label}</p>
      <p class="mt-1 truncate text-v2-text-text-base" classList={{ "font-mono": props.mono }} title={props.value}>
        {props.value}
      </p>
    </div>
  )
}

function formatTimestamp(value: number) {
  return value > 0 ? time.format(value) : "Unknown"
}

function formatClock(value: number) {
  return value > 0 ? clock.format(value) : "--:--:--"
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return "Replay request failed"
}
