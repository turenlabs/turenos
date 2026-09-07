import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { localLoopServer } from "../loops/local-server"
import {
  intelApi,
  type AdvisoriesPage,
  type IntelApi,
  type IntelSeverity,
  type IntelStatus,
  type KevPage,
  type NewsPage,
} from "./intel-api"
import {
  AdvisoryList,
  CacheAgeBadge,
  IntelEmpty,
  IntelError,
  IntelPager,
  KevList,
  NewsList,
  SeverityFilter,
} from "./intel-tables"

type IntelPane = "board" | "kev" | "news"

const PAGE_SIZE = 20

/**
 * Intel feed for Home: a zero-config security digest (Board/KEV/News)
 * over the server's cached feeds. Like the automations surfaces it
 * resolves the local server itself, so home stays a plain page render.
 */
export function IntelTab() {
  const server = useServer()
  const connection = createMemo(() => localLoopServer(server.list, server.scope))

  return (
    <Show when={connection()} keyed fallback={<IntelUnavailable />}>
      {(current) => <IntelContent connection={current} />}
    </Show>
  )
}

function IntelUnavailable() {
  return (
    <div data-component="intel-tab" class="flex min-h-0 flex-1 items-center justify-center px-5 py-10 text-center">
      <div class="max-w-sm">
        <p class="text-[13px] text-v2-text-text-base [font-weight:600]">Local server unavailable</p>
        <p class="mt-2 text-[13px] leading-5 text-v2-text-text-muted">
          Intel runs on your local TurenOS server. Start it to browse the security digest.
        </p>
      </div>
    </div>
  )
}

function IntelContent(props: { connection: ServerConnection.Any }) {
  const global = useGlobal()
  const [api, setApi] = createSignal<IntelApi>()
  const [clientError, setClientError] = createSignal<string>()
  const [pane, setPane] = createSignal<IntelPane>("board")
  const [severity, setSeverity] = createSignal<"all" | IntelSeverity>("all")
  const [searchInput, setSearchInput] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [advPage, setAdvPage] = createSignal(1)
  const [kevPage, setKevPage] = createSignal(1)
  const [newsPage, setNewsPage] = createSignal(1)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [advisories, setAdvisories] = createSignal<AdvisoriesPage>()
  const [kev, setKev] = createSignal<KevPage>()
  const [news, setNews] = createSignal<NewsPage>()
  const [status, setStatus] = createSignal<IntelStatus>()

  let version = 0
  const mounted = { value: true }
  onCleanup(() => {
    mounted.value = false
    version += 1
  })

  const boardQuery = () => ({
    page: advPage(),
    pageSize: PAGE_SIZE,
    ...(severity() === "all" ? {} : { severity: severity() as IntelSeverity }),
    ...(search().trim() ? { search: search().trim() } : {}),
  })

  async function loadStatus(client: IntelApi, ticket: number) {
    try {
      const next = await client.status()
      if (mounted.value && ticket === version) setStatus(next)
    } catch {
      // The age badge is informational; pane loads surface their own errors.
    }
  }

  async function loadBoard(client: IntelApi, ticket: number) {
    setLoading(true)
    setError(undefined)
    try {
      const next = await client.advisories(boardQuery())
      if (mounted.value && ticket === version) setAdvisories(next)
    } catch (loadError) {
      if (mounted.value && ticket === version)
        setError(loadError instanceof Error ? loadError.message : "Could not load advisories.")
    } finally {
      if (mounted.value && ticket === version) setLoading(false)
    }
  }

  async function loadPane(client: IntelApi, ticket: number, target: IntelPane) {
    if (target === "board") {
      await loadBoard(client, ticket)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      if (target === "kev") {
        const next = await client.kev({ page: kevPage(), pageSize: PAGE_SIZE })
        if (mounted.value && ticket === version) setKev(next)
      } else if (target === "news") {
        const next = await client.news({ page: newsPage(), pageSize: PAGE_SIZE })
        if (mounted.value && ticket === version) setNews(next)
      }
    } catch (loadError) {
      if (mounted.value && ticket === version)
        setError(loadError instanceof Error ? loadError.message : "Could not load intel.")
    } finally {
      if (mounted.value && ticket === version) setLoading(false)
    }
  }

  function current(): IntelApi | undefined {
    return api()
  }

  function refresh() {
    const client = current()
    if (!client) return
    version += 1
    const ticket = version
    setLoading(true)
    setError(undefined)
    // Refresh polls the feeds first: re-reading the cache alone would show
    // the same 6h-old rows and the age badge would never move.
    void client
      .poll()
      .then(() => {
        if (!mounted.value || ticket !== version) return
        void loadStatus(client, ticket)
        void loadPane(client, ticket, pane())
      })
      .catch((pollError) => {
        if (!mounted.value || ticket !== version) return
        setError(pollError instanceof Error ? pollError.message : "Could not refresh intel.")
        setLoading(false)
      })
  }

  function connect() {
    setClientError(undefined)
    setLoading(true)
    const ctx = global.ensureServerCtx(props.connection)
    void ctx.sdk
      .createProtocolClient()
      .then((protocol) => {
        if (!mounted.value) return
        const client = intelApi(protocol)
        setApi(client)
        version += 1
        const ticket = version
        void loadStatus(client, ticket)
        void loadBoard(client, ticket)
      })
      .catch((startupError) => {
        // A stale connect racing a newer one must not clobber its client.
        if (!mounted.value || current() !== undefined) return
        setLoading(false)
        setClientError(startupError instanceof Error ? startupError.message : "Could not connect to intel.")
      })
  }

  function retry() {
    // refresh() is a no-op before the client exists, so a failed connect
    // must reconnect instead.
    if (current()) {
      refresh()
      return
    }
    connect()
  }

  function selectPane(next: IntelPane) {
    if (next === pane()) return
    setPane(next)
    // The error banner is global; a cached pane switch must not keep showing
    // another pane's failure.
    setError(undefined)
    const client = current()
    if (!client) return
    version += 1
    const ticket = version
    setLoading(false)
    if (next === "board" && advisories() !== undefined) return
    if (next === "kev" && kev() !== undefined) return
    if (next === "news" && news() !== undefined) return
    void loadPane(client, ticket, next)
  }

  onMount(() => {
    connect()
  })

  const boardTotal = () => advisories()?.total

  return (
    <section data-component="intel-tab" aria-label="Threat intelligence" class="flex min-w-0 flex-col">
      <header class="terminal-home-heading">
        <div class="terminal-home-title">
          <h2>Vulnerabilities</h2>
          <span class="terminal-home-meta">
            {new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            {" / "}
            {status()?.feeds.length ?? "--"} sources{" / "}6h refresh
          </span>
        </div>
        <div class="flex items-center gap-5">
          <div class="terminal-home-metric">
            <strong>{boardTotal()?.toLocaleString() ?? "--"}</strong>
            <span>{search() || severity() !== "all" ? "Matches" : "Advisories"}</span>
          </div>
          <div class="terminal-home-metric">
            <strong>{status()?.feeds.filter((feed) => feed.lastOk).length ?? "--"}</strong>
            <span>Feeds OK</span>
          </div>
        </div>
      </header>

      <Show when={clientError()}>{(message) => <IntelError message={message()} onRetry={retry} />}</Show>

      <nav aria-label="Intel view" class="terminal-home-subnav !justify-start">
        <For
          each={
            [
              { id: "board", label: "Board" },
              { id: "kev", label: "KEV" },
              { id: "news", label: "News" },
            ] as const
          }
        >
          {(item) => (
            <button
              type="button"
              data-action={`intel-pane-${item.id}`}
              aria-pressed={pane() === item.id}
              onClick={() => selectPane(item.id)}
              class="terminal-home-tab"
            >
              {item.label}
              <Show when={item.id === "board" && boardTotal() !== undefined}>
                <span class="text-[10px] text-v2-text-text-muted [font-variant-numeric:tabular-nums]">
                  {boardTotal()?.toLocaleString()}
                </span>
              </Show>
              <Show when={item.id === "kev"}>
                <span class="terminal-home-meta">{kev()?.total.toLocaleString() ?? "Catalog"}</span>
              </Show>
              <Show when={item.id === "news"}>
                <span class="terminal-home-meta">{news()?.total.toLocaleString() ?? "Feeds"}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>

      <div class="terminal-home-source-strip">
        <span>
          sources{" "}
          {status()
            ?.feeds.map((feed) => feed.feedID)
            .join(" / ") || "awaiting feed status"}
        </span>
        <div class="flex flex-wrap items-center gap-3">
          <span>{status()?.lastPollAt ? "CACHED" : "WAITING"}</span>
          <CacheAgeBadge lastPollAt={status()?.lastPollAt} />
          <button
            type="button"
            class="terminal-home-action"
            data-action="intel-refresh"
            disabled={api() === undefined || loading()}
            onClick={refresh}
          >
            {loading() ? "Updating..." : "Refresh"}
          </button>
        </div>
      </div>

      <div aria-busy={loading()} class="min-w-0">
        <Show when={error()}>{(message) => <IntelError message={message()} onRetry={refresh} />}</Show>
        <Show when={loading() && pane() === "board" && advisories() === undefined}>
          <p class="px-3.5 py-8 text-center text-[12px] text-v2-text-text-muted">Loading intel…</p>
        </Show>
        <Switch>
          <Match when={pane() === "board"}>
            <Show when={advisories() !== undefined || !loading()}>
              <div class="terminal-home-filter">
                <SeverityFilter
                  value={severity()}
                  onChange={(next) => {
                    setSeverity(next)
                    setAdvPage(1)
                    const client = current()
                    if (!client) return
                    version += 1
                    void loadBoard(client, version)
                  }}
                />
                <form
                  class="terminal-home-search"
                  onSubmit={(event) => {
                    event.preventDefault()
                    setSearch(searchInput())
                    setAdvPage(1)
                    const client = current()
                    if (!client) return
                    version += 1
                    void loadBoard(client, version)
                  }}
                >
                  <input
                    type="search"
                    value={searchInput()}
                    placeholder="Search advisories…"
                    aria-label="Search advisories"
                    onInput={(event) => setSearchInput(event.currentTarget.value)}
                  />
                  <button type="submit" class="terminal-home-action" data-action="intel-search">
                    Search
                  </button>
                </form>
              </div>
              <Show
                when={(advisories()?.items.length ?? 0) > 0}
                fallback={
                  <IntelEmpty
                    title={search() || severity() !== "all" ? "No matching advisories" : "No advisories yet"}
                    hint={
                      search() || severity() !== "all"
                        ? "Try another search or select all severities."
                        : "Feeds are collected automatically. Refresh feeds to check for the latest advisories."
                    }
                  />
                }
              >
                <AdvisoryList items={advisories()?.items ?? []} />
                <IntelPager
                  page={advisories()?.page ?? 1}
                  pageSize={advisories()?.pageSize ?? PAGE_SIZE}
                  total={advisories()?.total ?? 0}
                  onPage={(next) => {
                    setAdvPage(next)
                    const client = current()
                    if (!client) return
                    version += 1
                    void loadBoard(client, version)
                  }}
                />
              </Show>
            </Show>
          </Match>
          <Match when={pane() === "kev"}>
            <Show
              when={kev() !== undefined || !loading()}
              fallback={<p class="px-3.5 py-8 text-center text-[12px] text-v2-text-text-muted">Loading intel…</p>}
            >
              <Show
                when={(kev()?.items.length ?? 0) > 0}
                fallback={
                  <IntelEmpty
                    title="No KEV items yet"
                    hint="Known-exploited vulnerabilities appear here once the server completes its first feed poll."
                  />
                }
              >
                <KevList items={kev()?.items ?? []} />
                <IntelPager
                  page={kev()?.page ?? 1}
                  pageSize={kev()?.pageSize ?? PAGE_SIZE}
                  total={kev()?.total ?? 0}
                  onPage={(next) => {
                    setKevPage(next)
                    const client = current()
                    if (!client) return
                    version += 1
                    void loadPane(client, version, "kev")
                  }}
                />
              </Show>
            </Show>
          </Match>
          <Match when={pane() === "news"}>
            <Show
              when={news() !== undefined || !loading()}
              fallback={<p class="px-3.5 py-8 text-center text-[12px] text-v2-text-text-muted">Loading intel…</p>}
            >
              <Show
                when={(news()?.items.length ?? 0) > 0}
                fallback={
                  <IntelEmpty
                    title="No news yet"
                    hint="Security headlines appear here once the server completes its first feed poll."
                  />
                }
              >
                <NewsList items={news()?.items ?? []} />
                <IntelPager
                  page={news()?.page ?? 1}
                  pageSize={news()?.pageSize ?? PAGE_SIZE}
                  total={news()?.total ?? 0}
                  onPage={(next) => {
                    setNewsPage(next)
                    const client = current()
                    if (!client) return
                    version += 1
                    void loadPane(client, version, "news")
                  }}
                />
              </Show>
            </Show>
          </Match>
        </Switch>
      </div>
    </section>
  )
}
