import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { ProxyPolicy } from "@turenlabs/protocol/proxy-policy"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import {
  canEditNote,
  codec,
  compareFlows,
  editableHeaders,
  editedBody,
  parseHeaders,
  parseRawRequest,
  previewRule,
  proxyOwner,
  repeaterTab,
  duplicateRepeaterTab,
  caseExport,
  type Draft,
  type RepeaterTab,
} from "./security-proxy-model"

const control =
  "min-w-0 rounded-[2px] border border-v2-border-border-muted bg-v2-background-bg-base px-1.5 py-0.5 text-[11px] leading-4 outline-none focus-visible:border-v2-border-border-focus disabled:opacity-50"
const button =
  "shrink-0 rounded-[2px] border border-v2-border-border-muted px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline focus-visible:outline-2 disabled:opacity-50 disabled:cursor-not-allowed"
const pre = "whitespace-pre-wrap break-all font-mono text-[11px] leading-4"
const paneTitle =
  "border-b border-v2-border-border-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-v2-text-text-faint"
const fmtBytes = (size: number) =>
  !size
    ? "—"
    : size >= 1048576
      ? `${(size / 1048576).toFixed(1)}M`
      : size >= 1024
        ? `${(size / 1024).toFixed(1)}k`
        : `${size}`
const statusText = (flow: SecurityProxy.Flow) => (flow.status !== undefined ? String(flow.status) : flow.state)
const statusClass = (flow: SecurityProxy.Flow) =>
  flow.status === undefined
    ? flow.state === "failed" || flow.state === "dropped"
      ? "text-v2-state-fg-danger"
      : "text-v2-text-text-faint"
    : flow.status < 300
      ? "text-v2-state-fg-success"
      : flow.status < 400
        ? "text-v2-state-fg-info"
        : flow.status < 500
          ? "text-v2-state-fg-warning"
          : "text-v2-state-fg-danger"
const menuItem =
  "block w-full px-3 py-1 text-left font-mono text-[11px] leading-4 hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
    .slice(0, 300)
const header = (items: readonly SecurityProxy.Header[], name: string) =>
  items.find((item) => item.name.toLowerCase() === name)?.value
const mime = (flow: SecurityProxy.Flow) => {
  const type = (header(flow.responseHeaders, "content-type") ?? "").toLowerCase()
  if (type.includes("json")) return "json"
  if (type.includes("html")) return "html"
  if (type.includes("javascript") || type.includes("ecmascript")) return "js"
  if (type.includes("css")) return "css"
  if (type.startsWith("image/")) return "img"
  if (type.startsWith("font/")) return "font"
  if (type.startsWith("text/")) return "txt"
  if (!type) return ""
  return type.split("/")[0] ?? ""
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB")
const emptyDraft = (): Draft => ({
  url: "",
  method: "GET",
  headers: "[]",
  body: "",
  encoding: "utf8",
  status: "200",
  complete: false,
})
function draft(request: SecurityProxy.Message, headers = request.headers, body = request.body, status = 200): Draft {
  return {
    url: request.url,
    method: request.method,
    headers: JSON.stringify(editableHeaders(headers), null, 2),
    body: body.data,
    encoding: body.encoding,
    status: String(status),
    complete: body.state === "complete",
  }
}
function edits(value: Draft, response = false): SecurityProxy.Edits {
  if (!value.complete) throw new Error("Only complete bodies can be edited.")
  const headers = parseHeaders(value.headers)
  const body = editedBody(value.body, value.encoding)
  if (response) {
    const status = Number(value.status)
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error("Response status must be 200–599.")
    const result = { status, headers, body }
    ProxyPolicy.validateEdits(result)
    return result
  }
  if (!/^https?:$/.test(new URL(value.url).protocol) || !/^[A-Z][A-Z0-9_-]{0,63}$/.test(value.method))
    throw new Error("Use an HTTP(S) URL and uppercase method.")
  const result = { url: value.url, method: value.method, headers, body }
  ProxyPolicy.validateEdits(result)
  return result
}

export default function SecurityProxyPage(props: { sessionID?: string; embedded?: boolean } = {}) {
  const platform = usePlatform()
  const server = useServer()
  const location = useLocation()
  const sessionID = () => props.sessionID ?? ""
  const supported = () =>
    !!platform.securityProxy && server.current?.type === "sidecar" && server.current.variant === "base"
  const directory = () => server.projects.last() ?? ""
  const serverSync = useServerSync()
  // Session-scoped owners come from the session record so directory and
  // workspaceID match the tool's Location identity exactly.
  const session = createMemo(() => {
    const id = sessionID()
    return id ? serverSync().session.peek(id) : undefined
  })
  const owner = createMemo(() =>
    proxyOwner({ directory: directory(), session: session(), sessionID: sessionID() || undefined }),
  )
  const [state, set] = createStore({
    caseID: "",
    cases: [] as SecurityProxy.Case[],
    current: undefined as SecurityProxy.Case | undefined,
    snapshot: undefined as SecurityProxy.Snapshot | undefined,
    flows: [] as SecurityProxy.Flow[],
    flow: undefined as SecurityProxy.Flow | undefined,
    revealed: false,
    note: "",
    tab: "History",
    pause: undefined as SecurityProxy.Pause | undefined,
    pauseDraft: emptyDraft(),
    pauseRevealed: false,
    repeaters: [] as RepeaterTab[],
    activeRepeaterID: "",
    rules: [] as { -readonly [K in keyof SecurityProxy.Rule]: SecurityProxy.Rule[K] }[],
    rulesRevision: 0,
    rulePreview: "",
    search: "",
    method: "",
    status: "",
    host: "",
    mime: "",
    source: "",
    content: false,
    filter: undefined as SecurityProxy.FlowFilter | undefined,
    nextCursor: undefined as SecurityProxy.FlowCursor | undefined,
    total: 0,
    historyLoaded: false,
    historyExpanded: false,
    historyCancelled: false,
    sort: "createdAt:desc",
    busy: "",
    error: "",
    notice: "",
    confirmation: "",
    clock: Date.now(),
    settle: "drop" as "drop" | "forward",
    name: "",
    exportOpen: false,
    exportFormat: "json" as "json" | "har",
    exportVisibility: "masked" as "masked" | "revealed",
    exportFiltered: false,
    exportCount: 0,
    exportCancelled: false,
    menu: undefined as { x: number; y: number; flow: SecurityProxy.Flow } | undefined,
    compareID: "",
    compare: undefined as ReturnType<typeof compareFlows> | undefined,
    hex: false,
    words: false,
    compareReveal: false,
    compareVisibility: "masked",
    decodeInput: "",
    decodeOutput: "",
    format: "URL" as "URL" | "Base64" | "Hex",
  })
  const [download, setDownload] = createSignal<{ blob: Blob; filename: string; count: number }>()
  const activeRepeater = createMemo(() => state.repeaters.find((tab) => tab.id === state.activeRepeaterID))
  const updateRepeater = (change: Partial<RepeaterTab>) => {
    const index = state.repeaters.findIndex((tab) => tab.id === state.activeRepeaterID)
    if (index !== -1) set("repeaters", index, change)
  }
  // One ordered IPC lane: polling never overlaps a decision or a lifecycle operation.
  let lane: Promise<unknown> = Promise.resolve()
  let epoch = 0
  let historyEpoch = 0
  let mounted = true
  let resolveConfirmation: ((confirmed: boolean) => void) | undefined
  const finishConfirmation = (confirmed: boolean) => {
    resolveConfirmation?.(confirmed)
    resolveConfirmation = undefined
    set("confirmation", "")
  }
  const confirm = (message: string) =>
    new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve
      set("confirmation", message)
    })
  const invoke = (command: SecurityProxy.Command, expected?: number) => {
    const api = platform.securityProxy
    const result = lane.then(() => {
      if (!api || (expected !== undefined && (expected !== epoch || !mounted))) throw new Error("Workspace changed.")
      return api.invoke(command)
    })
    lane = result.catch(() => undefined)
    return result
  }
  const owned = () => ({ owner: owner(), caseID: state.caseID })
  const action = async (label: string, fn: (version: number) => Promise<void> | void) => {
    if (state.busy) return
    const version = epoch
    set({ busy: label, error: "", notice: "" })
    try {
      await fn(version)
    } catch (error) {
      if (mounted && version === epoch)
        set("error", `${label} failed: ${reason(error)} Nothing is automatically resent.`)
    } finally {
      if (mounted && version === epoch) set("busy", "")
    }
  }
  const apply = (result: SecurityProxy.Result, version: number) => {
    if (!mounted || version !== epoch) return false
    if (result.snapshot) set("snapshot", reconcile(result.snapshot))
    if (result.cases) set("cases", reconcile([...result.cases]))
    return true
  }

  createEffect(
    on([directory, supported, sessionID, () => location.search], () => {
      const requested = new URLSearchParams(location.search).get("proxyCase") ?? ""
      const defaultCaseID = sessionID() ? `browser_${sessionID()}` : ""
      const next = requested || defaultCaseID
      set("caseID", supported() && /^[a-zA-Z0-9_-]{1,128}$/.test(next) ? next : "")
    }),
  )
  createEffect(() => {
    const id = sessionID()
    if (id && !serverSync().session.peek(id))
      void serverSync()
        .session.resolve(id)
        .catch(() => undefined)
  })
  createEffect(
    on([owner, supported, () => state.caseID], ([owner, available, caseID]) => {
      const version = ++epoch
      ++historyEpoch
      finishConfirmation(false)
      set({
        cases: [],
        current: undefined,
        snapshot: undefined,
        flows: [],
        flow: undefined,
        revealed: false,
        pause: undefined,
        pauseRevealed: false,
        pauseDraft: emptyDraft(),
        repeaters: [],
        activeRepeaterID: "",
        compare: undefined,
        compareID: "",
        exportOpen: false,
        exportCount: 0,
        exportVisibility: "masked",
        filter: undefined,
        nextCursor: undefined,
        total: 0,
        historyLoaded: false,
        historyExpanded: false,
        search: "",
        method: "",
        status: "",
        host: "",
        mime: "",
        source: "",
        content: false,
        compareReveal: false,
        menu: undefined,
        rules: [],
        note: "",
        busy: "",
        error: "",
        decodeInput: "",
        decodeOutput: "",
      })
      setDownload(undefined)
      if (!available || !owner.directory) {
        set("cases", [])
        return
      }
      let polling = false
      const refresh = async () => {
        if (polling || state.busy || version !== epoch) return
        polling = true
        try {
          if (props.embedded && caseID && !state.current) {
            const listed = await invoke({ type: "list", owner }, version)
            if (!apply(listed, version)) return
            const found = listed.cases?.find((item) => item.id === caseID)
            if (!found) return
            set({ current: found, rules: [...found.rules], rulesRevision: found.revision })
          }
          if (!caseID) {
            apply(await invoke({ type: "list", owner }, version), version)
            return
          }
          const snapshot = await invoke({ type: "snapshot", owner, caseID }, version)
          if (!apply(snapshot, version)) return
          if (!state.historyLoaded || (!state.historyExpanded && !state.filter)) {
            const historyVersion = historyEpoch
            const flows = await invoke({ type: "flows", owner, caseID }, version)
            if (version === epoch && historyVersion === historyEpoch && mounted && flows.flows) {
              set("flows", reconcile([...flows.flows]))
              set({
                nextCursor: flows.nextCursor,
                total: flows.total ?? flows.flows.length,
                historyLoaded: true,
              })
            }
          }
        } catch (error) {
          if (version === epoch && mounted)
            set("error", `Proxy refresh failed: ${reason(error)} Reconnecting reads only; requests are never resent.`)
        } finally {
          polling = false
        }
      }
      if (caseID) {
        void invoke({ type: "list", owner }, version)
          .then((result) => apply(result, version))
          .catch(() => undefined)
        void invoke({ type: "get", owner, caseID }, version)
          .then((result) => {
            if (version !== epoch || !mounted || !result.case) return
            set({ current: result.case, rules: [...result.case.rules], rulesRevision: result.case.revision })
          })
          .catch(() => {
            if (version === epoch && mounted && !props.embedded) set("error", "Could not load case.")
          })
      }
      void refresh()
      const timer = setInterval(() => {
        set("clock", Date.now())
        void refresh()
      }, 750)
      onCleanup(() => {
        clearInterval(timer)
        ++epoch
        // Close is deliberately outside the stale-read guard, ordered after any in-flight open.
        if (caseID) void invoke({ type: "close", owner, caseID }).catch(() => undefined)
      })
    }),
  )
  onCleanup(() => {
    mounted = false
    ++epoch
    finishConfirmation(false)
  })

  const visible = createMemo(() => {
    const list = state.flows
    const [key, dir] = state.sort.split(":")
    const order = dir === "asc" ? 1 : -1
    const value = (flow: SecurityProxy.Flow): string | number => {
      if (key === "method") return flow.request.method
      if (key === "url") return flow.request.url
      if (key === "type") return mime(flow)
      if (key === "status") return flow.status ?? -1
      if (key === "size") return flow.responseBody.size
      if (key === "durationMs") return flow.durationMs ?? -1
      return flow.createdAt
    }
    return list.toSorted((a, b) => {
      const left = value(a)
      const right = value(b)
      return order * (typeof left === "number" ? left - Number(right) : left.localeCompare(String(right)))
    })
  })
  const clickSort = (key: string) => set("sort", state.sort === `${key}:desc` ? `${key}:asc` : `${key}:desc`)
  const [historyScroll, setHistoryScroll] = createSignal<HTMLDivElement>()
  const historyRows = createVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    get count() {
      return visible().length
    },
    getScrollElement: () => historyScroll() ?? null,
    estimateSize: () => 21,
    overscan: 10,
    initialRect: { width: 800, height: 600 },
    getItemKey: (index) => visible()[index]?.id ?? index,
  })
  const loadHistory = (reset: boolean, all = false, filter = state.filter) =>
    action(all ? "Search complete case" : "Load history", async (version) => {
      set("historyCancelled", false)
      ++historyEpoch
      if (reset) set({ flows: [], nextCursor: undefined, filter, historyExpanded: !!filter })
      let cursor = reset ? undefined : state.nextCursor
      do {
        if (state.historyCancelled || version !== epoch || !mounted) return
        const result = await invoke({ type: "flows", ...owned(), cursor, filter }, version)
        if (!apply(result, version)) return
        const merged = new Map(state.flows.map((flow) => [flow.id, flow]))
        result.flows?.forEach((flow) => merged.set(flow.id, flow))
        set({
          flows: [...merged.values()],
          nextCursor: result.nextCursor,
          total: result.total ?? state.total,
          historyLoaded: true,
          historyExpanded: !reset || all || !!filter,
        })
        cursor = result.nextCursor
        if (!all) break
      } while (cursor)
      set("notice", `${state.flows.length} flows loaded${cursor ? "; older flows remain" : "; end of case"}.`)
    })
  const applyFilters = () =>
    loadHistory(true, true, {
      query: state.search.trim(),
      method: state.method.trim(),
      status: state.status.trim(),
      host: state.host.trim(),
      mime: state.mime.trim(),
      source: state.source === "browser" || state.source === "replay" ? state.source : undefined,
      content: state.content,
    })
  const currentPause = () => {
    const selected = state.pause
    return (
      selected &&
      state.snapshot?.pauses.find((pause) => pause.id === selected.id && pause.generation === selected.generation)
    )
  }
  const loadFlow = (flowID: string, reveal = false) =>
    action(reveal ? "Reveal flow" : "Load flow", async (version) => {
      const result = await invoke({ type: reveal ? "reveal" : "flow", ...owned(), flowID }, version)
      if (!apply(result, version)) return
      if (!result.flow) throw new Error("Flow was not returned.")
      set({ flow: result.flow, revealed: reveal, note: canEditNote(result.flow.note, reveal) ? result.flow.note : "" })
    })
  const sendToRepeater = (flowID: string) =>
    action("Send to Repeater", async (version) => {
      const result = await invoke({ type: "reveal", ...owned(), flowID }, version)
      if (!apply(result, version)) return
      if (!result.flow) throw new Error("Flow was not returned.")
      if (result.flow.request.body.state !== "complete")
        throw new Error("Request body is not complete; an incomplete body is never edited or replayed.")
      const tab = repeaterTab(result.flow)
      set({
        flow: result.flow,
        revealed: true,
        note: canEditNote(result.flow.note, true) ? result.flow.note : "",
        repeaters: [...state.repeaters, tab],
        activeRepeaterID: tab.id,
        tab: "Repeater",
      })
    })
  const decide = (decision: "forward" | "drop" | "extend" | "read" | "reveal", edited = false) =>
    action(`Intercept ${decision}`, async (version) => {
      const pause = currentPause()
      if (!pause) throw new Error("Pause expired.")
      if (edited && !state.pauseRevealed) throw new Error("Reveal this pause before editing.")
      const result = await invoke(
        {
          type: "decide",
          ...owned(),
          pauseID: pause.id,
          generation: pause.generation,
          decision,
          ...(edited ? { edits: edits(state.pauseDraft, pause.stage === "response") } : {}),
        },
        version,
      ).catch((error: unknown) => {
        // A settled/expired pause can never be decided again; drop the stale selection.
        if (/stale|already decided|not open/i.test(reason(error)))
          set({ pause: undefined, pauseRevealed: false, pauseDraft: emptyDraft() })
        throw error
      })
      if (!apply(result, version)) return
      if (decision === "drop" || decision === "forward") {
        set({ pause: undefined, pauseRevealed: false, notice: decision === "drop" ? "Dropped." : "Forwarded." })
        return
      }
      if (!result.pause) return
      set({ pause: result.pause })
      // Read does not imply reveal, and polling never writes into this draft.
      if (decision === "reveal")
        set({
          pauseRevealed: true,
          pauseDraft: draft(
            result.pause.request,
            result.pause.stage === "response" ? result.pause.headers : result.pause.request.headers,
            result.pause.stage === "response" ? result.pause.body : result.pause.request.body,
            result.pause.status,
          ),
        })
      if (decision === "read") set("pauseRevealed", false)
    })
  const lifecycle = (type: "open" | "close" | "reset") =>
    action(type, async (version) => {
      if (
        type !== "open" &&
        !(await confirm(
          type === "reset"
            ? "Reset this isolated profile? Cookies and site data will be removed; pending requests will be dropped."
            : "Close the isolated browser and drop pending requests?",
        ))
      )
        return
      apply(await invoke({ type, ...owned() }, version), version)
    })
  const changeIntercept = () =>
    action("Change intercept", async (version) => {
      const on = !state.snapshot?.intercept
      const settle = state.settle
      if (!on && !(await confirm(`Turn Intercept OFF and ${settle.toUpperCase()} all paused requests?`))) return
      apply(await invoke({ type: "intercept", ...owned(), on, settle }, version), version)
    })
  const settleAll = (decision: "forward" | "drop") =>
    action(`Intercept ${decision} all`, async (version) => {
      const pauses = state.snapshot?.pauses ?? []
      if (decision === "drop" && !(await confirm(`Drop all ${pauses.length} held requests?`))) return
      for (const pause of pauses)
        await invoke(
          { type: "decide", ...owned(), pauseID: pause.id, generation: pause.generation, decision },
          version,
        ).catch(() => undefined) // a pause that already settled itself is not an error here
      if (version === epoch && mounted)
        set({
          pause: undefined,
          pauseRevealed: false,
          notice: decision === "drop" ? "All dropped." : "All forwarded.",
        })
    })
  const pauseKeys = (event: KeyboardEvent) => {
    if (state.busy || !currentPause()) return
    const decision =
      event.key === "f"
        ? "forward"
        : event.key === "d"
          ? "drop"
          : event.key === "e"
            ? "extend"
            : event.key === "v"
              ? "reveal"
              : undefined
    if (!decision) return
    event.preventDefault()
    void decide(decision)
  }
  const sendReplay = () =>
    action("Send replay", async (version) => {
      const tab = activeRepeater()
      if (!tab) throw new Error("Select a Repeater tab.")
      const mutation = edits(tab.draft)
      const result = await invoke(
        {
          type: "replay",
          ...owned(),
          flowID: tab.flowID,
          replayID: crypto.randomUUID(),
          auth: tab.auth,
          edits: mutation,
        },
        version,
      )
      if (version === epoch && mounted) {
        const index = state.repeaters.findIndex((item) => item.id === tab.id)
        if (index !== -1 && result.flow)
          set("repeaters", index, {
            results: [...state.repeaters[index].results, result.flow],
            resultID: result.flow.id,
          })
        set(
          "notice",
          result.flow
            ? "Replay result received."
            : "No flow returned. Inspect History; do not assume the request was not sent.",
        )
      }
    })
  const exportFlows = () =>
    action("Build case export", async (version) => {
      const visibility = state.exportVisibility
      const format = state.exportFormat
      const filter = state.exportFiltered ? state.filter : undefined
      if (
        visibility === "revealed" &&
        !(await confirm("Export original requests, responses, cookies, tokens, and notes? Keep this file private."))
      )
        return
      if (version !== epoch || !mounted) return
      setDownload(undefined)
      set({ exportCount: 0, exportCancelled: false })
      if (!state.current) throw new Error("Case is unavailable.")
      const exported = caseExport({
        format,
        visibility,
        case: { id: state.current.id, name: state.current.name, createdAt: state.current.createdAt },
        filter,
      })
      let cursor: SecurityProxy.FlowCursor | undefined
      do {
        if (state.exportCancelled || version !== epoch || !mounted) return
        const result = await invoke({ type: "flows", ...owned(), cursor, filter, view: visibility }, version)
        if (!apply(result, version) || state.exportCancelled) return
        exported.append(result.flows ?? [])
        set("exportCount", exported.count)
        cursor = result.nextCursor
      } while (cursor)
      setDownload({
        blob: exported.finish(),
        filename: `${state.caseID}-${visibility}.${format === "har" ? "har" : "json"}`,
        count: state.exportCount,
      })
      set("notice", `${state.exportCount} flows exported. Review capture states and masking before sharing.`)
    })
  const compare = () =>
    action("Compare stored flows", async (version) => {
      if (!state.flow || !state.compareID) return
      const reveal = state.compareReveal
      if (reveal && !(await confirm("Reveal both responses for comparison? This can display protected values."))) return
      const type = reveal ? "reveal" : "flow"
      const hex = state.hex
      const words = state.words
      const left = await invoke({ type, ...owned(), flowID: state.flow.id }, version)
      const right = await invoke({ type, ...owned(), flowID: state.compareID }, version)
      if (version === epoch && mounted && left.flow && right.flow)
        set({
          compare: compareFlows(left.flow, right.flow, hex, words),
          compareVisibility: reveal ? "revealed" : "masked",
        })
    })
  const moveSelection = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "r" && (event.ctrlKey || event.metaKey)) {
      if (state.flow && state.flow.request.body.state === "complete") void sendToRepeater(state.flow.id)
      event.preventDefault()
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const list = visible()
    if (!list.length) return
    event.preventDefault()
    const index = list.findIndex((flow) => flow.id === state.flow?.id)
    const next =
      index === -1
        ? event.key === "ArrowDown"
          ? 0
          : list.length - 1
        : event.key === "ArrowDown"
          ? Math.min(list.length - 1, index + 1)
          : Math.max(0, index - 1)
    if (list[next] && list[next].id !== state.flow?.id) {
      historyRows.scrollToIndex(next, { align: "auto" })
      void loadFlow(list[next].id)
    }
  }

  return (
    <section
      data-component="security-proxy"
      class="flex h-full min-h-0 flex-col overflow-hidden bg-v2-background-bg-base text-[12px] leading-5 text-v2-text-text-base"
    >
      <Show when={!props.embedded}>
        <header class="flex items-baseline gap-3 border-b border-v2-border-border-muted px-2 py-1">
          <span class="text-[13px] font-medium">Proxy</span>
          <span class="text-[11px] text-v2-text-text-muted">
            Isolated browser for HTTP(S) traffic. No model, AI scan, or system proxy required.
          </span>
          <span class="ml-auto truncate font-mono text-[11px] text-v2-text-text-faint">{directory()}</span>
        </header>
      </Show>
      <Show
        when={supported()}
        fallback={
          <p class="p-3 text-[11px] text-v2-text-text-muted" role="status">
            Proxy requires the desktop app's local base sidecar. Web, remote, and WSL connections are not supported.
          </p>
        }
      >
        <Show
          when={directory()}
          fallback={
            <p class="p-3 text-[11px] text-v2-text-text-muted" role="status">
              Open a local project to own this Proxy case.
            </p>
          }
        >
          <div class="flex min-h-0 flex-1">
            <Show when={!props.embedded}>
              <aside class="w-60 shrink-0 space-y-2 overflow-y-auto border-r border-v2-border-border-muted p-2">
                <label class="block space-y-0.5 text-[11px] text-v2-text-text-muted">
                  Case
                  <select
                    class={`${control} w-full`}
                    value={state.caseID}
                    disabled={!!state.busy}
                    onChange={(event) => set("caseID", event.currentTarget.value)}
                  >
                    <option value="">New case</option>
                    <For each={state.cases}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                  </select>
                </label>
                <button
                  class={button}
                  disabled={!!state.busy}
                  onClick={() =>
                    action("Refresh cases", async (version) => {
                      apply(await invoke({ type: "list", owner: owner() }, version), version)
                    })
                  }
                >
                  Refresh cases
                </button>
                <details open={!state.caseID || !state.current}>
                  <summary class="cursor-pointer text-[11px] text-v2-text-text-muted">Create case</summary>
                  <div class="mt-1 space-y-1">
                    <Field label="Name" value={state.name} set={(value) => set("name", value)} />
                    <button
                      class={button}
                      disabled={!!state.busy}
                      onClick={() =>
                        action("Create case", async (version) => {
                          const current = owner()
                          const id = sessionID() ? `browser_${sessionID()}` : crypto.randomUUID()
                          const created = await invoke(
                            {
                              type: "create",
                              owner: current,
                              input: { id, name: state.name.trim() || "Browser case" },
                            },
                            version,
                          )
                          if (!created.case || version !== epoch || !mounted) return
                          if (state.caseID) await invoke({ type: "close", ...owned() }, version)
                          await invoke({ type: "open", owner: current, caseID: created.case.id }, version)
                          if (version !== epoch || !mounted) {
                            await invoke({ type: "close", owner: current, caseID: created.case.id })
                            return
                          }
                          set("cases", [...state.cases.filter((item) => item.id !== id), created.case])
                          set("caseID", created.case.id)
                        })
                      }
                    >
                      Create &amp; open browser
                    </button>
                  </div>
                </details>
                <Show when={state.current}>
                  {(item) => (
                    <div class="space-y-1 border-t border-v2-border-border-muted pt-1 text-[11px] text-v2-text-text-muted">
                      <p>Revision {item().revision}</p>
                      <button
                        class={button}
                        disabled={!!state.busy}
                        onClick={() =>
                          action("Delete case", async (version) => {
                            if (
                              !(await confirm(
                                "Permanently delete this case and its flows? The isolated browser will close.",
                              ))
                            )
                              return
                            const target = owned()
                            await invoke({ type: "close", ...target }, version)
                            await invoke({ type: "delete", ...target }, version)
                            if (version === epoch && mounted) {
                              set(
                                "cases",
                                state.cases.filter((item) => item.id !== target.caseID),
                              )
                              set("caseID", "")
                            }
                          })
                        }
                      >
                        Delete case…
                      </button>
                    </div>
                  )}
                </Show>
              </aside>
            </Show>
            <main class="flex min-w-0 flex-1 flex-col">
              <Show
                when={props.embedded ? state.current : state.caseID}
                fallback={
                  <p class="p-3 text-[11px] text-v2-text-text-muted">
                    {props.embedded
                      ? "Waiting for the agent to start the session browser. Use browser_start in this session to begin."
                      : "Create or select a case."}
                  </p>
                }
              >
                <div class="flex h-7 items-center border-b border-v2-border-border-muted px-2 font-mono text-[11px] leading-4">
                  <div class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
                    <span class={state.snapshot?.open ? "text-v2-state-fg-success" : "text-v2-text-text-faint"}>
                      {state.snapshot?.open ? "● open" : "○ closed"}
                    </span>
                    <span class={state.snapshot?.intercept ? "text-v2-state-fg-warning" : "text-v2-text-text-faint"}>
                      int:{state.snapshot?.intercept ? "on" : "off"}
                    </span>
                    <Show when={state.snapshot?.pauses.length}>
                      <span class="text-v2-state-fg-warning">held:{state.snapshot?.pauses.length}</span>
                    </Show>
                    <Show when={state.snapshot?.url}>
                      <span class="min-w-0 max-w-80 truncate text-v2-text-text-muted" title={state.snapshot?.url}>
                        {state.snapshot?.url}
                      </span>
                    </Show>
                    <Show when={state.snapshot?.open}>
                      <span class="hidden text-v2-text-text-faint lg:inline" title={state.snapshot?.generation}>
                        gen:{(state.snapshot?.generation ?? "").slice(0, 8)}
                      </span>
                    </Show>
                    <Show when={state.snapshot?.error}>
                      <span role="alert" class="min-w-0 truncate text-v2-state-fg-danger" title={state.snapshot?.error}>
                        {state.snapshot?.error}
                      </span>
                    </Show>
                    <span
                      class="ml-auto min-w-0 truncate text-right text-v2-text-text-muted"
                      role="status"
                      aria-live="polite"
                    >
                      {state.busy ? `${state.busy}…` : state.notice}
                    </span>
                  </div>
                  <div class="flex shrink-0 items-center gap-1 pl-2">
                    <button
                      class={button}
                      disabled={!!state.busy}
                      onClick={() => lifecycle("open")}
                      title="Open or focus the isolated browser"
                    >
                      Open
                    </button>
                    <button
                      class={button}
                      disabled={!!state.busy}
                      onClick={() => lifecycle("close")}
                      title="Close the isolated browser and drop pending requests"
                    >
                      Close…
                    </button>
                    <button
                      class={button}
                      disabled={!!state.busy}
                      onClick={() => lifecycle("reset")}
                      title="Reset the isolated profile; cookies and site data are removed"
                    >
                      Reset…
                    </button>
                    <details class="relative">
                      <summary
                        class={`${button} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
                        title="Scope and limitations"
                      >
                        ?
                      </summary>
                      <div class="absolute right-0 z-20 mt-1 w-80 space-y-1 border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-2 font-sans text-[11px] leading-4 text-v2-text-text-muted shadow-[var(--v2-elevation-floating)]">
                        <p>
                          {props.embedded
                            ? "Agent-shared browser: state, pauses, history, and replays are shared with this session."
                            : "Inspect HTTP(S) traffic in an isolated browser. No model, AI scan, or system proxy required."}
                        </p>
                        <p>
                          HTTP(S) test mode bypasses service workers. Popup sign-in, downloads, WebSocket editing, and
                          client certificates are not supported.
                        </p>
                        <p>
                          Changing case or project closes the old browser and drops its paused traffic. Closing this
                          page also closes its browser.
                        </p>
                      </div>
                    </details>
                  </div>
                </div>
                <Show when={state.error}>
                  <p
                    role="alert"
                    class="border-b border-v2-border-border-muted px-2 py-0.5 text-[11px] leading-4 text-v2-state-fg-danger"
                  >
                    {state.error}
                  </p>
                </Show>
                <Show when={state.confirmation}>
                  <div
                    role="alertdialog"
                    aria-label="Confirm Proxy action"
                    class="flex items-center gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1"
                  >
                    <span class="min-w-0 flex-1 text-[11px]">{state.confirmation}</span>
                    <button class={button} autofocus onClick={() => finishConfirmation(false)}>
                      Cancel
                    </button>
                    <button class={button} onClick={() => finishConfirmation(true)}>
                      Confirm
                    </button>
                  </div>
                </Show>
                <nav
                  aria-label="Proxy tools"
                  class="flex items-center gap-0.5 border-b border-v2-border-border-muted px-2 py-0.5"
                >
                  <For each={["History", "Intercept", "Repeater", "Rules", "Codec"]}>
                    {(tab) => (
                      <button
                        class={`rounded-[2px] px-2 py-0.5 text-[11px] leading-4 ${
                          state.tab === tab
                            ? "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base"
                            : "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
                        }`}
                        aria-pressed={state.tab === tab}
                        onClick={() => set("tab", tab)}
                      >
                        {tab}
                        {tab === "Intercept" && state.snapshot?.pauses.length
                          ? ` (${state.snapshot?.pauses.length})`
                          : ""}
                      </button>
                    )}
                  </For>
                </nav>
                <Show when={state.tab === "History"}>
                  <form
                    class="flex flex-wrap items-center gap-1 border-b border-v2-border-border-muted px-2 py-1"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void applyFilters()
                    }}
                  >
                    <input
                      class={`${control} max-w-72`}
                      placeholder="Search case"
                      aria-label="Case search"
                      value={state.search}
                      onInput={(event) => set("search", event.currentTarget.value)}
                    />
                    <input
                      class={`${control} w-20`}
                      placeholder="Method"
                      aria-label="Method filter"
                      value={state.method}
                      onInput={(event) => set("method", event.currentTarget.value)}
                    />
                    <input
                      class={`${control} w-16`}
                      placeholder="Status"
                      aria-label="Status filter"
                      value={state.status}
                      onInput={(event) => set("status", event.currentTarget.value)}
                    />
                    <input
                      class={`${control} w-36`}
                      placeholder="Exact host"
                      aria-label="Host filter"
                      value={state.host}
                      onInput={(event) => set("host", event.currentTarget.value)}
                    />
                    <input
                      class={`${control} w-28`}
                      placeholder="MIME type"
                      aria-label="MIME filter"
                      value={state.mime}
                      onInput={(event) => set("mime", event.currentTarget.value)}
                    />
                    <select
                      class={control}
                      aria-label="Source filter"
                      value={state.source}
                      onChange={(event) => set("source", event.currentTarget.value)}
                    >
                      <option value="">All sources</option>
                      <option value="browser">Browser</option>
                      <option value="replay">Replay</option>
                    </select>
                    <label
                      class="flex items-center gap-1 text-[11px] text-v2-text-text-muted"
                      title="Search masked headers and text bodies across the case. Protected values and notes are not searchable."
                    >
                      <input
                        type="checkbox"
                        checked={state.content}
                        onChange={(event) => set("content", event.currentTarget.checked)}
                      />
                      masked content
                    </label>
                    <button class={button} disabled={!!state.busy} type="submit">
                      Apply to case
                    </button>
                    <button
                      class={button}
                      disabled={!!state.busy}
                      type="button"
                      onClick={() => {
                        set({
                          search: "",
                          method: "",
                          status: "",
                          host: "",
                          mime: "",
                          source: "",
                          content: false,
                          filter: undefined,
                        })
                        void loadHistory(true, false, undefined)
                      }}
                    >
                      Clear
                    </button>
                    <button
                      class={`${button} ml-auto`}
                      disabled={!!state.busy}
                      type="button"
                      onClick={() => set("exportOpen", !state.exportOpen)}
                      title="Export complete case requests and responses as JSON or HAR"
                    >
                      Export…
                    </button>
                  </form>
                  <div class="flex flex-wrap items-center gap-1 border-b border-v2-border-border-muted px-2 py-0.5">
                    <span class="mr-auto text-[11px] text-v2-text-text-faint">
                      {visible().length} loaded · {state.total} stored
                      {state.filter ? " · case filters applied" : ""}
                      {state.historyExpanded ? " · refresh to include new traffic" : " · live latest page"}
                    </span>
                    <button class={button} disabled={!!state.busy} onClick={() => loadHistory(true, !!state.filter)}>
                      Refresh
                    </button>
                    <button
                      class={button}
                      disabled={!!state.busy || !state.nextCursor}
                      onClick={() => loadHistory(false)}
                    >
                      Load older
                    </button>
                    <button
                      class={button}
                      disabled={!!state.busy || !state.nextCursor}
                      onClick={() => loadHistory(false, true)}
                    >
                      Load all
                    </button>
                    <Show when={state.busy === "Search complete case"}>
                      <button class={button} onClick={() => set("historyCancelled", true)}>
                        Stop loading
                      </button>
                    </Show>
                  </div>
                  <div
                    class={`overflow-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] focus-within:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] ${
                      state.flow ? "max-h-[40%] shrink-0" : "min-h-0 flex-1"
                    }`}
                    ref={setHistoryScroll}
                    tabIndex={0}
                    onKeyDown={moveSelection}
                    aria-label="Captured flows"
                    title="Right-click a row for actions · Ctrl/Cmd+R sends to Repeater · ↑/↓ moves selection"
                  >
                    <table class="w-full table-fixed border-collapse font-mono text-[11px] leading-5">
                      <thead class="sticky top-0 z-10 bg-v2-background-bg-layer-01 text-left text-v2-text-text-faint">
                        <tr>
                          <Th id="method" label="Method" class="w-16" sort={state.sort} click={clickSort} />
                          <Th id="url" label="URL" sort={state.sort} click={clickSort} />
                          <Th id="status" label="Status" class="w-14" sort={state.sort} click={clickSort} />
                          <Th id="type" label="Type" class="w-14" sort={state.sort} click={clickSort} />
                          <Th id="size" label="Size" class="w-16 text-right" sort={state.sort} click={clickSort} />
                          <Th id="durationMs" label="ms" class="w-14 text-right" sort={state.sort} click={clickSort} />
                          <Th id="createdAt" label="Time" class="w-16" sort={state.sort} click={clickSort} />
                          <th class="w-14 px-2 py-0 font-normal">Src</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr aria-hidden="true">
                          <td
                            colSpan={8}
                            style={{ height: `${historyRows.getVirtualItems()[0]?.start ?? 0}px`, padding: "0" }}
                          />
                        </tr>
                        <For
                          each={historyRows
                            .getVirtualItems()
                            .map((row) => visible()[row.index])
                            .filter((flow) => flow !== undefined)}
                        >
                          {(flow) => (
                            <tr
                              class={`cursor-pointer border-t border-v2-border-border-muted outline-none hover:bg-v2-overlay-simple-overlay-hover ${
                                state.flow?.id === flow.id ? "bg-v2-overlay-simple-overlay-hover" : ""
                              }`}
                              tabIndex={-1}
                              onClick={() => loadFlow(flow.id)}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                if (state.flow?.id !== flow.id) void loadFlow(flow.id)
                                set("menu", {
                                  x: Math.min(event.clientX, window.innerWidth - 190),
                                  y: Math.min(event.clientY, window.innerHeight - 150),
                                  flow,
                                })
                              }}
                            >
                              <td class="truncate px-2 py-0">{flow.request.method}</td>
                              <td class="truncate px-2 py-0" title={flow.request.url}>
                                {flow.request.url}
                              </td>
                              <td class={`truncate px-2 py-0 ${statusClass(flow)}`}>{statusText(flow)}</td>
                              <td class="truncate px-2 py-0 text-v2-text-text-muted">{mime(flow)}</td>
                              <td class="px-2 py-0 text-right text-v2-text-text-muted">
                                {fmtBytes(flow.responseBody.size)}
                              </td>
                              <td class="px-2 py-0 text-right text-v2-text-text-muted">{flow.durationMs ?? ""}</td>
                              <td class="truncate px-2 py-0 text-v2-text-text-muted">{clock(flow.createdAt)}</td>
                              <td class="truncate px-2 py-0 text-v2-text-text-muted">
                                {flow.source}
                                {flow.note ? " ✎" : ""}
                                {flow.error ? " !" : ""}
                              </td>
                            </tr>
                          )}
                        </For>
                        <tr aria-hidden="true">
                          <td
                            colSpan={8}
                            style={{
                              height: `${Math.max(0, historyRows.getTotalSize() - (historyRows.getVirtualItems().at(-1)?.end ?? 0))}px`,
                              padding: "0",
                            }}
                          />
                        </tr>
                      </tbody>
                    </table>
                    <Show when={!visible().length}>
                      <p class="px-2 py-2 text-[11px] text-v2-text-text-muted">No matching flows.</p>
                    </Show>
                  </div>
                  <Show when={state.exportOpen}>
                    <div class="shrink-0 space-y-1 border-t border-v2-border-border-muted px-2 py-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <select
                          class={control}
                          aria-label="Export format"
                          value={state.exportFormat}
                          disabled={!!state.busy}
                          onChange={(event) => {
                            set("exportFormat", event.currentTarget.value === "har" ? "har" : "json")
                            setDownload(undefined)
                          }}
                        >
                          <option value="json">Case JSON</option>
                          <option value="har">HAR 1.2</option>
                        </select>
                        <select
                          class={control}
                          aria-label="Export visibility"
                          value={state.exportVisibility}
                          disabled={!!state.busy}
                          onChange={(event) => {
                            set("exportVisibility", event.currentTarget.value === "revealed" ? "revealed" : "masked")
                            setDownload(undefined)
                          }}
                        >
                          <option value="masked">Masked</option>
                          <option value="revealed">Originals (contains secrets)</option>
                        </select>
                        <label class="flex items-center gap-1 text-[11px] text-v2-text-text-muted">
                          <input
                            type="checkbox"
                            checked={state.exportFiltered}
                            disabled={!!state.busy}
                            onChange={(event) => {
                              set("exportFiltered", event.currentTarget.checked)
                              setDownload(undefined)
                            }}
                          />
                          applied case filters
                        </label>
                        <button class={button} disabled={!!state.busy} onClick={exportFlows}>
                          Build export
                        </button>
                        <Show when={state.busy === "Build case export"}>
                          <span class="text-[11px]">{state.exportCount} flows</span>
                          <button
                            class={button}
                            onClick={() => {
                              set("exportCancelled", true)
                              set("notice", "Export cancelled; no file created.")
                            }}
                          >
                            Cancel
                          </button>
                        </Show>
                        <Show when={download()}>
                          {(file) => (
                            <button
                              class={button}
                              disabled={!!state.busy}
                              onClick={() => {
                                const url = URL.createObjectURL(file().blob)
                                const anchor = document.createElement("a")
                                anchor.href = url
                                anchor.download = file().filename
                                anchor.click()
                                setTimeout(() => URL.revokeObjectURL(url), 1000)
                              }}
                            >
                              Download {file().count} flows
                            </button>
                          )}
                        </Show>
                        <button
                          class={`${button} ml-auto`}
                          disabled={!!state.busy}
                          onClick={() => {
                            set("exportOpen", false)
                            setDownload(undefined)
                          }}
                          aria-label="Dismiss export"
                        >
                          Close
                        </button>
                      </div>
                      <p class="text-[11px] text-v2-text-text-muted">
                        Includes all stored pages, not just loaded rows. Masked bodies are bounded previews; originals
                        preserve captured bytes. Capture states identify missing or truncated data. Masking cannot
                        detect every secret. Review files before sharing.
                      </p>
                    </div>
                  </Show>
                  <Show when={state.flow}>
                    {(flow) => (
                      <div class="flex min-h-0 flex-1 flex-col border-t border-v2-border-border-muted">
                        <div class="flex items-center gap-2 border-b border-v2-border-border-muted px-2 py-0.5">
                          <span class="font-mono text-[11px] font-medium">{flow().request.method}</span>
                          <span class="min-w-0 truncate font-mono text-[11px]" title={flow().request.url}>
                            {flow().request.url}
                          </span>
                          <span class={`shrink-0 font-mono text-[11px] ${statusClass(flow())}`}>
                            {statusText(flow())}
                          </span>
                          <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                            {flow().durationMs !== undefined ? `${flow().durationMs}ms ` : ""}
                            {flow().responseBody.size ? `· ${fmtBytes(flow().responseBody.size)} ` : ""}·{" "}
                            {flow().source}
                            {state.revealed ? " · raw" : " · masked"}
                          </span>
                          <span class="ml-auto flex shrink-0 gap-1">
                            <button
                              class={button}
                              disabled={!!state.busy || state.revealed}
                              onClick={() => loadFlow(flow().id, true)}
                              title="Reveal raw headers, bodies, and secrets"
                            >
                              Reveal
                            </button>
                            <button
                              class={button}
                              disabled={!!state.busy || flow().request.body.state !== "complete"}
                              onClick={() => sendToRepeater(flow().id)}
                              title="Reveal the raw request and load it in Repeater. Requires a complete body; copy as curl is intentionally unavailable."
                            >
                              →Repeater
                            </button>
                          </span>
                        </div>
                        <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 divide-y divide-v2-border-border-muted overflow-hidden xl:grid-cols-2 xl:grid-rows-1 xl:divide-x xl:divide-y-0">
                          <MessagePane
                            title="Request"
                            line={`${flow().request.method} ${flow().request.url}`}
                            headers={flow().request.headers}
                            body={flow().request.body}
                          />
                          <MessagePane
                            title={`Response${flow().status !== undefined ? ` · ${flow().status}` : ""}`}
                            headers={flow().responseHeaders}
                            body={flow().responseBody}
                            foot={
                              <>
                                <Show when={flow().error}>
                                  <p class="mt-1 text-v2-state-fg-danger">error recorded — reveal for detail</p>
                                </Show>
                                <Show when={flow().originalResponse}>
                                  {(original) => (
                                    <details class="mt-1">
                                      <summary class="cursor-pointer text-v2-text-text-muted">
                                        Original response · {original().status}
                                      </summary>
                                      <HeadersList items={original().headers} />
                                      <BodyBlock body={original().body} />
                                    </details>
                                  )}
                                </Show>
                                <Show when={flow().note}>
                                  <p class="mt-1 text-v2-text-text-muted">note: {flow().note}</p>
                                </Show>
                              </>
                            }
                          />
                        </div>
                        <div class="max-h-[38%] shrink-0 overflow-y-auto border-t border-v2-border-border-muted">
                          <details class="border-b border-v2-border-border-muted">
                            <summary class="cursor-pointer px-2 py-0.5 text-[11px] text-v2-text-text-muted">
                              Analyst note{flow().note ? " · set" : ""}
                            </summary>
                            <div class="px-2 pb-1">
                              <Show
                                when={canEditNote(flow().note, state.revealed)}
                                fallback={
                                  <div class="flex items-center gap-2">
                                    <p role="status" class="text-[11px] text-v2-text-text-muted">
                                      Protected note — reveal before editing or replacing it.
                                    </p>
                                    <button
                                      class={button}
                                      disabled={!!state.busy}
                                      onClick={() => loadFlow(flow().id, true)}
                                    >
                                      Reveal note &amp; flow
                                    </button>
                                  </div>
                                }
                              >
                                <textarea
                                  class={`${control} min-h-12 w-full font-mono`}
                                  value={state.note}
                                  disabled={!!state.busy}
                                  onInput={(event) => set("note", event.currentTarget.value)}
                                  spellcheck={false}
                                  aria-label="Analyst note"
                                />
                                <button
                                  class={`${button} mt-1`}
                                  disabled={!!state.busy || state.note === "[REDACTED]"}
                                  onClick={() =>
                                    action("Save note", async (version) => {
                                      if (!canEditNote(flow().note, state.revealed) || state.note === "[REDACTED]")
                                        throw new Error("Reveal the original note before replacing it.")
                                      const note = state.note
                                      await invoke({ type: "note", ...owned(), flowID: flow().id, note }, version)
                                      if (version !== epoch || !mounted) return
                                      set({
                                        flow: { ...flow(), note: state.revealed ? note : note ? "[REDACTED]" : "" },
                                        note: state.revealed ? state.note : "",
                                        notice: "Note saved.",
                                      })
                                    })
                                  }
                                >
                                  Save note
                                </button>
                              </Show>
                            </div>
                          </details>
                          <details class="border-b border-v2-border-border-muted">
                            <summary class="cursor-pointer px-2 py-0.5 text-[11px] text-v2-text-text-muted">
                              Compare stored responses
                            </summary>
                            <div class="flex items-center gap-1 px-2 pb-1">
                              <select
                                class={`${control} max-w-96`}
                                value={state.compareID}
                                onChange={(event) => set("compareID", event.currentTarget.value)}
                                aria-label="Other flow"
                              >
                                <option value="">Select flow</option>
                                <For each={state.flows.filter((item) => item.id !== flow().id)}>
                                  {(item) => (
                                    <option value={item.id}>
                                      {item.request.method} {item.request.url} · {item.status ?? item.state}
                                    </option>
                                  )}
                                </For>
                              </select>
                              <label class="flex shrink-0 items-center gap-1 text-[11px] text-v2-text-text-muted">
                                <input
                                  type="checkbox"
                                  checked={state.hex}
                                  onChange={(event) => set("hex", event.currentTarget.checked)}
                                />
                                hex
                              </label>
                              <label class="flex shrink-0 items-center gap-1 text-[11px] text-v2-text-text-muted">
                                <input
                                  type="checkbox"
                                  checked={state.words}
                                  disabled={state.hex}
                                  onChange={(event) => set("words", event.currentTarget.checked)}
                                />
                                words
                              </label>
                              <label class="flex shrink-0 items-center gap-1 text-[11px] text-v2-text-text-muted">
                                <input
                                  type="checkbox"
                                  checked={state.compareReveal}
                                  onChange={(event) => set("compareReveal", event.currentTarget.checked)}
                                />
                                reveal both
                              </label>
                              <button class={button} disabled={!!state.busy || !state.compareID} onClick={compare}>
                                Compare
                              </button>
                            </div>
                            <Show when={state.compare}>
                              {(comparison) => (
                                <div class="px-2 pb-1">
                                  <p class="text-[11px] text-v2-text-text-muted">
                                    {comparison().equal
                                      ? "Visible response content matches"
                                      : "Visible response content differs or is incomplete"}
                                    {` (${state.compareVisibility} view)`}
                                  </p>
                                  <Show when={comparison().limited}>
                                    <p class="text-[11px] text-v2-state-fg-warning">
                                      Comparison is bounded to 64 KiB per body and a diff time limit. No full-response
                                      equality is claimed.
                                    </p>
                                  </Show>
                                  <pre
                                    class={`${pre} mt-1 max-h-64 overflow-auto border border-v2-border-border-muted p-1`}
                                    aria-label="Response differences"
                                  >
                                    <For each={comparison().changes}>
                                      {(change) => (
                                        <span
                                          class={
                                            change.added
                                              ? "bg-v2-state-bg-success text-v2-state-fg-success"
                                              : change.removed
                                                ? "bg-v2-state-bg-danger text-v2-state-fg-danger"
                                                : "text-v2-text-text-muted"
                                          }
                                        >
                                          {change.added ? "+ " : change.removed ? "- " : "  "}
                                          {change.value}
                                        </span>
                                      )}
                                    </For>
                                  </pre>
                                  <div class="mt-1 grid gap-1 xl:grid-cols-2">
                                    <pre
                                      class={`${pre} max-h-48 overflow-auto border border-v2-border-border-muted p-1`}
                                    >
                                      {comparison().left}
                                    </pre>
                                    <pre
                                      class={`${pre} max-h-48 overflow-auto border border-v2-border-border-muted p-1`}
                                    >
                                      {comparison().right}
                                    </pre>
                                  </div>
                                </div>
                              )}
                            </Show>
                          </details>
                          <details>
                            <summary class="cursor-pointer px-2 py-0.5 text-[11px] text-v2-text-text-muted">
                              Raw JSON
                            </summary>
                            <pre class={`${pre} max-h-64 overflow-auto px-2 pb-1`}>
                              {JSON.stringify(flow(), null, 2)}
                            </pre>
                          </details>
                        </div>
                      </div>
                    )}
                  </Show>
                  <Show when={state.menu}>
                    {(menu) => (
                      <>
                        <div
                          class="fixed inset-0 z-30"
                          onClick={() => set("menu", undefined)}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            set("menu", undefined)
                          }}
                        />
                        <div
                          role="menu"
                          aria-label="Flow actions"
                          class="fixed z-40 min-w-44 border border-v2-border-border-muted bg-v2-background-bg-layer-01 py-0.5 shadow-[var(--v2-elevation-floating)]"
                          style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
                          tabIndex={-1}
                          ref={(element) => element.focus()}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") set("menu", undefined)
                          }}
                        >
                          <button
                            class={menuItem}
                            role="menuitem"
                            disabled={!!state.busy}
                            onClick={() => {
                              const flowID = menu().flow.id
                              set("menu", undefined)
                              void sendToRepeater(flowID)
                            }}
                          >
                            Send to Repeater
                          </button>
                          <button
                            class={menuItem}
                            role="menuitem"
                            disabled={!!state.busy || (state.flow?.id === menu().flow.id && state.revealed)}
                            onClick={() => {
                              const flowID = menu().flow.id
                              set("menu", undefined)
                              void loadFlow(flowID, true)
                            }}
                          >
                            Reveal raw
                          </button>
                          <div class="my-0.5 border-t border-v2-border-border-muted" />
                          <button
                            class={menuItem}
                            role="menuitem"
                            onClick={() => {
                              const url = menu().flow.request.url
                              set("menu", undefined)
                              void navigator.clipboard.writeText(url)
                            }}
                          >
                            Copy URL
                          </button>
                          <button
                            class={menuItem}
                            role="menuitem"
                            onClick={() => {
                              const json = JSON.stringify(menu().flow, null, 2)
                              set("menu", undefined)
                              void navigator.clipboard.writeText(json)
                            }}
                          >
                            Copy masked JSON
                          </button>
                          <div class="my-0.5 border-t border-v2-border-border-muted" />
                          <button
                            class={menuItem}
                            role="menuitem"
                            onClick={() => {
                              const flow = menu().flow
                              set("menu", undefined)
                              set("rules", [
                                ...state.rules,
                                {
                                  id: crypto.randomUUID(),
                                  enabled: true,
                                  stage: "request",
                                  path: URL.parse(flow.request.url)?.pathname || "/",
                                  method: flow.request.method,
                                  action: "pause",
                                  find: "",
                                  replace: "",
                                },
                              ])
                              set({ tab: "Rules", notice: "Pause rule drafted — review and Save to apply." })
                            }}
                          >
                            Hold similar (pause rule)
                          </button>
                        </div>
                      </>
                    )}
                  </Show>
                </Show>
                <Show when={state.tab === "Intercept"}>
                  <div class="flex items-center gap-1 border-b border-v2-border-border-muted px-2 py-1">
                    <button
                      class={button}
                      disabled={!!state.busy || !state.snapshot?.open}
                      onClick={changeIntercept}
                      aria-pressed={!!state.snapshot?.intercept}
                      title={
                        state.snapshot?.intercept
                          ? `Turn intercept off and ${state.settle} all paused requests`
                          : "Hold requests and responses for review"
                      }
                    >
                      Intercept: {state.snapshot?.intercept ? "on" : "off"}
                    </button>
                    <label class="flex shrink-0 items-center gap-1 text-[11px] text-v2-text-text-muted">
                      off settles
                      <select
                        class={control}
                        value={state.settle}
                        onChange={(event) =>
                          set("settle", event.currentTarget.value === "forward" ? "forward" : "drop")
                        }
                      >
                        <option value="drop">drop</option>
                        <option value="forward">forward</option>
                      </select>
                    </label>
                    <span class="ml-auto flex min-w-0 items-center gap-1">
                      <span class="truncate text-right text-[11px] text-v2-text-text-faint">
                        queue {state.snapshot?.pauses.length ?? 0}
                        <span class="hidden lg:inline"> · auto-drop at deadline · f/d/e/v decide</span>
                      </span>
                      <Show when={(state.snapshot?.pauses.length ?? 0) > 1}>
                        <button
                          class={button}
                          disabled={!!state.busy}
                          onClick={() => settleAll("forward")}
                          title="Forward every held request"
                        >
                          Fwd all
                        </button>
                        <button
                          class={button}
                          disabled={!!state.busy}
                          onClick={() => settleAll("drop")}
                          title="Drop every held request"
                        >
                          Drop all…
                        </button>
                      </Show>
                    </span>
                  </div>
                  <div
                    class="max-h-[30%] shrink-0 overflow-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] focus-within:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
                    tabIndex={0}
                    onKeyDown={pauseKeys}
                    aria-label="Held traffic queue"
                  >
                    <table class="w-full table-fixed border-collapse font-mono text-[11px] leading-5">
                      <tbody>
                        <For each={state.snapshot?.pauses}>
                          {(pause) => (
                            <tr
                              class={`cursor-pointer border-t border-v2-border-border-muted outline-none first:border-t-0 hover:bg-v2-overlay-simple-overlay-hover ${
                                state.pause?.id === pause.id ? "bg-v2-overlay-simple-overlay-hover" : ""
                              }`}
                              tabIndex={-1}
                              aria-pressed={state.pause?.id === pause.id}
                              onClick={() => set({ pause, pauseRevealed: false, pauseDraft: emptyDraft() })}
                            >
                              <td class="w-16 px-2 py-0 text-v2-text-text-muted">{pause.stage.toUpperCase()}</td>
                              <td class="w-16 px-2 py-0">{pause.request.method}</td>
                              <td class="truncate px-2 py-0" title={pause.request.url}>
                                {pause.request.url}
                              </td>
                              <td class="w-16 px-2 py-0 text-right text-v2-text-text-muted">
                                {Math.max(0, Math.ceil((pause.deadline - state.clock) / 1000))}s
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                    <Show when={!state.snapshot?.pauses.length}>
                      <p class="px-2 py-2 text-[11px] text-v2-text-text-muted">No held traffic.</p>
                    </Show>
                  </div>
                  <Show
                    when={currentPause()}
                    fallback={
                      <Show when={state.snapshot?.pauses.length}>
                        <p class="p-3 text-[11px] text-v2-text-text-muted">
                          Select a held request. Expired or settled pauses cannot be edited.
                        </p>
                      </Show>
                    }
                  >
                    {(pause) => {
                      // After reveal, state.pause holds the raw value; the snapshot's copy stays masked.
                      const shown = () => (state.pauseRevealed && state.pause ? state.pause : pause())
                      return (
                        <div class="flex min-h-0 flex-1 flex-col border-t border-v2-border-border-muted">
                          <div class="flex items-center gap-1 border-b border-v2-border-border-muted px-2 py-0.5">
                            <span class="font-mono text-[11px] text-v2-text-text-muted">
                              {pause().stage} · abort in{" "}
                              {Math.max(0, Math.ceil((pause().deadline - state.clock) / 1000))}s
                            </span>
                            <span class="ml-auto flex gap-1">
                              <button class={button} disabled={!!state.busy} onClick={() => decide("forward")}>
                                Forward
                              </button>
                              <button class={button} disabled={!!state.busy} onClick={() => decide("drop")}>
                                Drop
                              </button>
                              <button
                                class={button}
                                disabled={!!state.busy}
                                onClick={() => decide("extend")}
                                title="Extend the pause deadline"
                              >
                                +TTL
                              </button>
                              <Show when={pause().stage === "response"}>
                                <button
                                  class={button}
                                  disabled={!!state.busy || pause().reading}
                                  onClick={() => decide("read")}
                                  title="Read the held response body"
                                >
                                  Read body
                                </button>
                              </Show>
                              <button
                                class={button}
                                disabled={!!state.busy}
                                onClick={() => decide("reveal")}
                                title="Reveal raw values for editing"
                              >
                                Reveal
                              </button>
                            </span>
                          </div>
                          <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 divide-y divide-v2-border-border-muted overflow-hidden xl:grid-cols-2 xl:grid-rows-1 xl:divide-x xl:divide-y-0">
                            <MessagePane
                              title="Held request"
                              line={`${shown().request.method} ${shown().request.url}`}
                              headers={shown().request.headers}
                              body={shown().request.body}
                            />
                            <Show
                              when={pause().stage === "response"}
                              fallback={
                                <div class="flex items-center justify-center p-2 text-[11px] text-v2-text-text-faint">
                                  Request stage — forward or drop to release it to History.
                                </div>
                              }
                            >
                              <MessagePane
                                title={`Response · ${shown().status ?? "—"}`}
                                headers={shown().headers}
                                body={shown().body}
                              />
                            </Show>
                          </div>
                          <details class="max-h-[35%] shrink-0 overflow-y-auto border-t border-v2-border-border-muted">
                            <summary class="cursor-pointer px-2 py-0.5 text-[11px] text-v2-text-text-muted">
                              Raw pause JSON
                            </summary>
                            <pre class={`${pre} px-2 pb-1`}>{JSON.stringify(shown(), null, 2)}</pre>
                          </details>
                          <Show when={state.pauseRevealed}>
                            <div class="max-h-[45%] shrink-0 overflow-y-auto border-t border-v2-border-border-muted px-2 py-1">
                              <div class="flex h-72 min-h-0 flex-col">
                                <RawEditor
                                  value={state.pauseDraft}
                                  response={pause().stage === "response"}
                                  update={(key, value) => set("pauseDraft", key, value)}
                                />
                              </div>
                              <div class="mt-1 flex items-center gap-2">
                                <button
                                  class={button}
                                  disabled={!!state.busy || !state.pauseDraft.complete}
                                  onClick={() => decide("forward", true)}
                                >
                                  Forward edited once
                                </button>
                                <span class="text-[10px] text-v2-text-text-faint">
                                  Pauses have no captured flow ID — settle first, then use History → Repeater.
                                </span>
                              </div>
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </Show>
                </Show>
                <Show when={state.tab === "Repeater"}>
                  <div
                    role="tablist"
                    aria-label="Repeater requests"
                    class="flex shrink-0 gap-1 overflow-x-auto border-b border-v2-border-border-muted px-2 py-1"
                  >
                    <For each={state.repeaters}>
                      {(tab) => (
                        <button
                          role="tab"
                          aria-selected={state.activeRepeaterID === tab.id}
                          class={`${button} ${state.activeRepeaterID === tab.id ? "bg-v2-overlay-simple-overlay-hover" : ""}`}
                          onClick={() => set("activeRepeaterID", tab.id)}
                        >
                          {tab.name}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show
                    when={activeRepeater()}
                    fallback={
                      <p class="p-3 text-[11px] text-v2-text-text-muted">
                        Send a captured request from History to create a tab. Drafts stay in memory until you leave this
                        case. Sent flows remain in case history.
                      </p>
                    }
                  >
                    {(tab) => {
                      const result = () => tab().results.find((flow) => flow.id === tab().resultID)
                      return (
                        <>
                          <div class="flex items-center gap-1 border-b border-v2-border-border-muted px-2 py-1">
                            <input
                              class={`${control} min-w-0 flex-1`}
                              aria-label="Repeater tab name"
                              value={tab().name}
                              onInput={(event) => updateRepeater({ name: event.currentTarget.value })}
                            />
                            <button
                              class={button}
                              disabled={!!state.busy}
                              onClick={() => {
                                const copy = duplicateRepeaterTab(tab())
                                set({ repeaters: [...state.repeaters, copy], activeRepeaterID: copy.id })
                              }}
                            >
                              Duplicate
                            </button>
                            <button
                              class={button}
                              disabled={!!state.busy}
                              onClick={() => {
                                void action("Close Repeater tab", async () => {
                                  const tabID = tab().id
                                  if (
                                    !(await confirm(
                                      "Close this tab and discard its draft? Sent requests remain in case history.",
                                    ))
                                  )
                                    return
                                  const remaining = state.repeaters.filter((item) => item.id !== tabID)
                                  set({
                                    repeaters: remaining,
                                    activeRepeaterID:
                                      state.activeRepeaterID === tabID
                                        ? (remaining[0]?.id ?? "")
                                        : state.activeRepeaterID,
                                  })
                                })
                              }}
                            >
                              Close
                            </button>
                            <label
                              class="flex shrink-0 items-center gap-1 text-[11px] text-v2-text-text-muted"
                              title="Captured sends the draft headers as-is. Live refreshes cookies from this case's profile and keeps the other draft headers."
                            >
                              auth
                              <select
                                class={control}
                                value={tab().auth}
                                onChange={(event) =>
                                  updateRepeater({ auth: event.currentTarget.value === "live" ? "live" : "captured" })
                                }
                              >
                                <option value="captured">captured</option>
                                <option value="live">live</option>
                              </select>
                            </label>
                            <button
                              class={button}
                              disabled={!!state.busy || !tab().draft.complete}
                              onClick={sendReplay}
                              title="Send once (Ctrl/Cmd+Enter). Redirects are never followed and nothing is resent automatically."
                            >
                              Send
                            </button>
                          </div>
                          <div
                            class="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 divide-y divide-v2-border-border-muted overflow-hidden xl:grid-cols-2 xl:grid-rows-1 xl:divide-x xl:divide-y-0"
                            onKeyDown={(event) => {
                              if (
                                event.key === "Enter" &&
                                (event.ctrlKey || event.metaKey) &&
                                !state.busy &&
                                tab().draft.complete
                              )
                                void sendReplay()
                            }}
                          >
                            <div class="flex min-h-0 flex-col p-1">
                              <details class="mb-1 shrink-0 border border-v2-border-border-muted">
                                <summary class="cursor-pointer px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-v2-text-text-faint">
                                  Paste raw request
                                </summary>
                                <div class="space-y-1 p-1">
                                  <textarea
                                    class={`${control} h-24 w-full font-mono`}
                                    placeholder={"POST /path HTTP/1.1\nHost: target.example\n\n…"}
                                    aria-label="Raw HTTP request"
                                    value={tab().raw}
                                    onInput={(event) => updateRepeater({ raw: event.currentTarget.value })}
                                    spellcheck={false}
                                  />
                                  <button
                                    class={button}
                                    onClick={() => {
                                      const parsed = parseRawRequest(tab().raw)
                                      if (!parsed) {
                                        set(
                                          "error",
                                          "Could not parse the raw request. Expected 'METHOD /path HTTP/1.1' plus a Host header or an absolute URL.",
                                        )
                                        return
                                      }
                                      updateRepeater({
                                        draft: {
                                          url: parsed.url,
                                          method: parsed.method,
                                          headers: JSON.stringify(editableHeaders(parsed.headers), null, 2),
                                          body: parsed.body,
                                          encoding: "utf8",
                                          status: tab().draft.status,
                                          complete: true,
                                        },
                                      })
                                    }}
                                  >
                                    Load
                                  </button>
                                </div>
                              </details>
                              <RawEditor
                                value={tab().draft}
                                update={(key, value) => updateRepeater({ draft: { ...tab().draft, [key]: value } })}
                              />
                            </div>
                            <div class="flex min-h-0 min-w-0 flex-col">
                              <div class={paneTitle}>
                                Result{result() ? ` · ${result()!.status ?? result()!.state}` : ""}
                              </div>
                              <select
                                class={`${control} m-1`}
                                aria-label="Repeater send history"
                                value={tab().resultID}
                                onChange={(event) => updateRepeater({ resultID: event.currentTarget.value })}
                              >
                                <option value="" selected={!tab().resultID}>
                                  Select a send
                                </option>
                                <For each={tab().results}>
                                  {(flow, index) => (
                                    <option value={flow.id} selected={tab().resultID === flow.id}>
                                      Send {index() + 1} · {flow.status ?? flow.state} · {flow.durationMs ?? "?"}ms
                                    </option>
                                  )}
                                </For>
                              </select>
                              <div class="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[11px] leading-4">
                                <Show
                                  when={result()}
                                  fallback={
                                    <p class="text-v2-text-text-faint">
                                      No result selected. Each send is explicit; redirects and retries stay off.
                                    </p>
                                  }
                                >
                                  {(result) => (
                                    <>
                                      <Show when={state.flows.find((flow) => flow.id === tab().flowID)}>
                                        {(source) => (
                                          <p class="text-v2-text-text-faint">
                                            src {source().status ?? source().state}
                                            {source().durationMs !== undefined ? ` · ${source().durationMs}ms` : ""}
                                            {source().responseBody.size
                                              ? ` · ${fmtBytes(source().responseBody.size)}`
                                              : ""}
                                            {" → "}
                                            <span class={statusClass(result())}>
                                              {result().status ?? result().state}
                                            </span>
                                            {result().durationMs !== undefined ? ` · ${result().durationMs}ms` : ""}
                                            {result().responseBody.size
                                              ? ` · ${fmtBytes(result().responseBody.size)}`
                                              : ""}
                                          </p>
                                        )}
                                      </Show>
                                      <HeadersList items={result().responseHeaders} />
                                      <BodyBlock body={result().responseBody} />
                                      <Show when={result().note}>
                                        <p class="mt-1 text-v2-text-text-muted">note: {result().note}</p>
                                      </Show>
                                      <details class="mt-1">
                                        <summary class="cursor-pointer text-v2-text-text-muted">
                                          Raw result JSON
                                        </summary>
                                        <pre class={pre}>{JSON.stringify(result(), null, 2)}</pre>
                                      </details>
                                    </>
                                  )}
                                </Show>
                              </div>
                            </div>
                          </div>
                        </>
                      )
                    }}
                  </Show>
                </Show>
                <Show when={state.tab === "Rules"}>
                  <div class="flex items-center gap-1 border-b border-v2-border-border-muted px-2 py-1">
                    <span
                      class="text-[11px] text-v2-text-text-muted"
                      title="Ordered rules. Paths and methods scope matching; replacements are literal, never regex or executable code. Save is explicit; polling does not replace your draft."
                    >
                      rev {state.rulesRevision} · ordered · literal only
                    </span>
                    <span class="ml-auto flex gap-1">
                      <button
                        class={button}
                        disabled={!!state.busy || state.rules.length >= 100}
                        onClick={() =>
                          set("rules", [
                            ...state.rules,
                            {
                              id: crypto.randomUUID(),
                              enabled: true,
                              stage: "request",
                              path: "/",
                              method: "",
                              action: "pass",
                              find: "",
                              replace: "",
                            },
                          ])
                        }
                      >
                        Add
                      </button>
                      <button
                        class={button}
                        disabled={!!state.busy}
                        onClick={() =>
                          action("Save rules", async (version) => {
                            const result = await invoke(
                              {
                                type: "rules",
                                ...owned(),
                                revision: state.rulesRevision,
                                rules: state.rules.map((rule) => ({ ...rule })),
                              },
                              version,
                            )
                            if (version === epoch && mounted && result.case)
                              set({
                                current: result.case,
                                rulesRevision: result.case.revision,
                                notice: "Rules saved.",
                              })
                          })
                        }
                      >
                        Save
                      </button>
                      <button
                        class={button}
                        disabled={!!state.busy}
                        onClick={() =>
                          action("Reload rules", async (version) => {
                            if (!(await confirm("Discard rule edits and reload the stored revision?"))) return
                            const result = await invoke({ type: "get", ...owned() }, version)
                            if (version === epoch && mounted && result.case)
                              set({
                                current: result.case,
                                rules: [...result.case.rules],
                                rulesRevision: result.case.revision,
                              })
                          })
                        }
                      >
                        Reload…
                      </button>
                    </span>
                  </div>
                  <div class="min-h-0 flex-1 overflow-auto p-1">
                    <For each={state.rules}>
                      {(rule, index) => (
                        <div class="mb-1 border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-1">
                          <div class="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={(event) => set("rules", index(), "enabled", event.currentTarget.checked)}
                              aria-label="Enabled"
                              title="Enabled"
                            />
                            <input
                              class={`${control} w-44 font-mono`}
                              value={rule.id}
                              onInput={(event) => set("rules", index(), "id", event.currentTarget.value)}
                              aria-label="Rule ID"
                              title="Rule ID"
                            />
                            <select
                              class={control}
                              value={rule.stage}
                              onChange={(event) =>
                                set(
                                  "rules",
                                  index(),
                                  "stage",
                                  event.currentTarget.value === "response" ? "response" : "request",
                                )
                              }
                              aria-label="Stage"
                              title="Stage"
                            >
                              <option value="request">request</option>
                              <option value="response">response</option>
                            </select>
                            <select
                              class={control}
                              value={rule.action}
                              onChange={(event) =>
                                set(
                                  "rules",
                                  index(),
                                  "action",
                                  event.currentTarget.value === "replace"
                                    ? "replace"
                                    : event.currentTarget.value === "pause"
                                      ? "pause"
                                      : "pass",
                                )
                              }
                              aria-label="Action"
                              title="Action"
                            >
                              <option value="pass">pass</option>
                              <option value="pause">pause</option>
                              <option value="replace">replace</option>
                            </select>
                            <button
                              class={`${button} ml-auto`}
                              disabled={!!state.busy}
                              onClick={() =>
                                set(
                                  "rules",
                                  state.rules.filter((_, position) => position !== index()),
                                )
                              }
                              aria-label="Remove rule"
                            >
                              ×
                            </button>
                          </div>
                          <div class="mt-1 grid grid-cols-[1fr_7rem_1fr_1fr] gap-1">
                            <input
                              class={control}
                              value={rule.path}
                              onInput={(event) => set("rules", index(), "path", event.currentTarget.value)}
                              placeholder="Path prefix"
                              aria-label="Path prefix"
                            />
                            <input
                              class={control}
                              value={rule.method}
                              onInput={(event) => set("rules", index(), "method", event.currentTarget.value)}
                              placeholder="Method"
                              aria-label="Method (empty = all)"
                              title="Method (empty = all)"
                            />
                            <input
                              class={`${control} font-mono`}
                              value={rule.find}
                              onInput={(event) => set("rules", index(), "find", event.currentTarget.value)}
                              placeholder="Find literal"
                              aria-label="Find literal"
                            />
                            <input
                              class={`${control} font-mono`}
                              value={rule.replace}
                              onInput={(event) => set("rules", index(), "replace", event.currentTarget.value)}
                              placeholder="Replace literal"
                              aria-label="Replace literal"
                            />
                          </div>
                          <Show when={rule.action === "replace" && rule.find}>
                            <pre class={`${pre} mt-1 max-h-16 overflow-auto text-v2-text-text-muted`}>
                              {previewRule(state.rulePreview, rule)}
                            </pre>
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={!state.rules.length}>
                      <p class="p-2 text-[11px] text-v2-text-text-muted">No rules — traffic passes unchanged.</p>
                    </Show>
                  </div>
                  <div class="border-t border-v2-border-border-muted px-2 py-1">
                    <input
                      class={`${control} w-full font-mono`}
                      placeholder="Literal preview input (never sends traffic)"
                      aria-label="Literal preview input"
                      value={state.rulePreview}
                      onInput={(event) => set("rulePreview", event.currentTarget.value)}
                    />
                  </div>
                </Show>
                <Show when={state.tab === "Codec"}>
                  <div class="flex items-center gap-1 border-b border-v2-border-border-muted px-2 py-1">
                    <select
                      class={control}
                      value={state.format}
                      onChange={(event) =>
                        set(
                          "format",
                          event.currentTarget.value === "Hex"
                            ? "Hex"
                            : event.currentTarget.value === "Base64"
                              ? "Base64"
                              : "URL",
                        )
                      }
                      aria-label="Codec format"
                    >
                      <option>URL</option>
                      <option>Base64</option>
                      <option>Hex</option>
                    </select>
                    <button
                      class={button}
                      disabled={!!state.busy}
                      onClick={() =>
                        action("Encode", () => set("decodeOutput", codec(state.decodeInput, state.format, false)))
                      }
                    >
                      Encode →
                    </button>
                    <button
                      class={button}
                      disabled={!!state.busy}
                      onClick={() =>
                        action("Decode", () => set("decodeOutput", codec(state.decodeInput, state.format, true)))
                      }
                    >
                      Decode →
                    </button>
                    <span class="ml-auto text-[11px] text-v2-text-text-faint">local only — nothing is sent</span>
                  </div>
                  <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 divide-y divide-v2-border-border-muted overflow-hidden xl:grid-cols-2 xl:grid-rows-1 xl:divide-x xl:divide-y-0">
                    <textarea
                      class={`${control} m-1 min-h-0 font-mono`}
                      placeholder="Input"
                      aria-label="Codec input"
                      value={state.decodeInput}
                      onInput={(event) => set("decodeInput", event.currentTarget.value)}
                      spellcheck={false}
                    />
                    <pre class={`${pre} m-1 min-h-0 overflow-auto`}>{state.decodeOutput}</pre>
                  </div>
                </Show>
              </Show>
            </main>
          </div>
        </Show>
      </Show>
    </section>
  )
}

function Field(props: {
  label: string
  value: string
  set(value: string): void
  multiline?: boolean
  disabled?: boolean
}) {
  return (
    <label class="block min-w-0 space-y-0.5 text-[11px] text-v2-text-text-muted">
      <span>{props.label}</span>
      <Show
        when={props.multiline}
        fallback={
          <input
            class={`${control} w-full`}
            value={props.value}
            disabled={props.disabled}
            onInput={(event) => props.set(event.currentTarget.value)}
          />
        }
      >
        <textarea
          class={`${control} min-h-16 w-full font-mono`}
          value={props.value}
          disabled={props.disabled}
          onInput={(event) => props.set(event.currentTarget.value)}
          spellcheck={false}
        />
      </Show>
    </label>
  )
}

function HeadersList(props: { items: readonly SecurityProxy.Header[] }) {
  return (
    <Show when={props.items.length} fallback={<p class="text-v2-text-text-faint">no headers captured</p>}>
      <For each={props.items}>
        {(item) => (
          <p class="break-all">
            <span class="text-v2-text-text-muted">{item.name}:</span> {item.value}
          </p>
        )}
      </For>
    </Show>
  )
}

function Th(props: { id: string; label: string; class?: string; sort: string; click(id: string): void }) {
  return (
    <th
      class={`cursor-pointer select-none px-2 py-0 font-normal hover:text-v2-text-text-base ${props.class ?? ""}`}
      onClick={() => props.click(props.id)}
    >
      {props.label}
      {props.sort === `${props.id}:asc` ? " ▲" : props.sort === `${props.id}:desc` ? " ▼" : ""}
    </th>
  )
}

function BodyBlock(props: { body: SecurityProxy.Body }) {
  const shown = () => props.body.data.slice(0, 65536)
  const json = createMemo(() => {
    if (props.body.encoding !== "utf8") return ""
    const trimmed = shown().trimStart()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return ""
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return ""
    }
  })
  const [pretty, setPretty] = createSignal(false)
  return (
    <Show
      when={props.body.state === "complete" || props.body.state === "truncated"}
      fallback={
        <p class="mt-1 text-v2-text-text-faint">
          body: {props.body.state}
          {props.body.size ? ` · ${fmtBytes(props.body.size)}` : ""}
        </p>
      }
    >
      <pre class="mt-1 whitespace-pre-wrap break-all">
        {props.body.encoding === "base64" ? "[binary body shown as base64]\n" : ""}
        {pretty() && json() ? json() : shown()}
        {props.body.data.length > shown().length
          ? `\n… ${props.body.data.length - shown().length} more characters`
          : ""}
      </pre>
      <Show when={json()}>
        <button
          class="mt-0.5 text-[10px] uppercase tracking-wide text-v2-text-text-faint hover:text-v2-text-text-base"
          onClick={() => setPretty(!pretty())}
        >
          {pretty() ? "raw" : "pretty json"}
        </button>
      </Show>
    </Show>
  )
}

function MessagePane(props: {
  title: string
  line?: string
  headers: readonly SecurityProxy.Header[]
  body: SecurityProxy.Body
  foot?: JSX.Element
}) {
  return (
    <section class="flex min-h-0 min-w-0 flex-col">
      <div class={paneTitle}>{props.title}</div>
      <div class="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[11px] leading-4">
        <Show when={props.line}>
          <p class="break-all">{props.line}</p>
        </Show>
        <div class="mt-0.5">
          <HeadersList items={props.headers} />
        </div>
        <BodyBlock body={props.body} />
        {props.foot}
      </div>
    </section>
  )
}

function RawEditor(props: {
  value: Draft
  response?: boolean
  update<K extends keyof Draft>(key: K, value: Draft[K]): void
}) {
  return (
    <fieldset disabled={!props.value.complete} class="flex min-h-0 flex-1 flex-col gap-1">
      <Show when={!props.value.complete}>
        <p class="text-[11px] text-v2-text-text-muted">
          Body is not complete. Editing is disabled to avoid replacing truncated or unavailable data.
        </p>
      </Show>
      <Show
        when={props.response}
        fallback={
          <div class="flex gap-1">
            <input
              class={`${control} w-20 font-mono`}
              value={props.value.method}
              onInput={(event) => props.update("method", event.currentTarget.value)}
              aria-label="Method"
              placeholder="METHOD"
            />
            <input
              class={`${control} font-mono`}
              value={props.value.url}
              onInput={(event) => props.update("url", event.currentTarget.value)}
              aria-label="URL"
              placeholder="https://…"
            />
          </div>
        }
      >
        <input
          class={`${control} w-24 font-mono`}
          value={props.value.status}
          onInput={(event) => props.update("status", event.currentTarget.value)}
          aria-label="Response status"
          placeholder="Status"
        />
      </Show>
      <textarea
        class={`${control} min-h-14 w-full font-mono`}
        value={props.value.headers}
        onInput={(event) => props.update("headers", event.currentTarget.value)}
        spellcheck={false}
        aria-label='Headers JSON array [{"name","value"}]'
        placeholder='Headers JSON [{"name","value"}]'
      />
      <textarea
        class={`${control} min-h-0 w-full flex-1 font-mono`}
        value={props.value.body}
        onInput={(event) => props.update("body", event.currentTarget.value)}
        spellcheck={false}
        aria-label={`Body (${props.value.encoding}; maximum 1 MiB)`}
        placeholder={`Body (${props.value.encoding}; ≤ 1 MiB)`}
      />
      <p class="text-[10px] leading-4 text-v2-text-text-faint">
        Framing headers omitted · Content-Encoding preserved · Host, Content-Length, transfer encoding, and Connection
        are set by the transport.
      </p>
    </fieldset>
  )
}
