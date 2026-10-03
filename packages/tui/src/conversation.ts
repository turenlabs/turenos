import { errorText, type Connection } from "./server"
import { display, pendingQuestions, transcript } from "./messages"
import { label, type DashboardState } from "./state"
import { scheduleText, welcomeBody } from "./chrome"
import { color } from "./theme"
import type { DashboardLayout } from "./layout"
import type { MessagesListOutput } from "@turenlabs/client"
import { TextBufferRenderable, type Renderable } from "@opentui/core"

export function createConversation(
  state: DashboardState,
  connection: Connection,
  ui: DashboardLayout,
  hooks: {
    actions: () => void
    say: (message: string, error?: boolean) => void
    clearNotice: (message: string) => void
    project?: (sessionID: string, messages: MessagesListOutput["data"]) => MessagesListOutput["data"]
    questionsInPanel?: boolean
  },
) {
  let error = ""
  let lastPending = ""
  let loading: Promise<void> | undefined
  let disposed = false
  let pageRequest: { sessionID: string; cursor: string; direction: "next" | "previous" } | undefined
  const positions = new Map<string, { history: boolean; latest: number; transcript: number; cursor?: string }>()
  let position: { sessionID: string; history: boolean; scroll: number } | undefined
  let beforeQuestion: typeof position
  type LivePage = {
    messages: { id: string; formatted: string; raw: string }[]
    cursor?: string
    capped: boolean
    expanded: boolean
    boundary?: string
  }
  const live = new Map<string, LivePage>()
  let earlier: Promise<void> | undefined
  let generation = 0
  let viewKey = ""
  let prepend: { height: number; scroll: number } | undefined
  let textAnchor:
    | {
        node: TextBufferRenderable
        width: number
        source: number
        column: number
        row: number
      }
    | undefined

  // Keep a logical text location from the last painted frame. Native lineInfo
  // handles word wrapping, tabs and wide characters; numeric offsets cannot.
  const renderAfter = ui.detail.renderAfter
  ui.detail.renderAfter = function (buffer, delta) {
    renderAfter?.call(this, buffer, delta)
    if (state.tab !== "sessions" || state.modal?.inline || state.detail?.sessionID !== state.selected) {
      textAnchor = undefined
      return
    }
    const anchor = textAnchor
    if (anchor && !anchor.node.isDestroyed && anchor.node.width !== anchor.width) {
      const info = anchor.node.lineInfo
      let line = -1
      for (let i = 0; i < info.lineSources.length; i++) {
        if (info.lineSources[i] === anchor.source && info.lineStartCols[i]! <= anchor.column) line = i
      }
      textAnchor = undefined
      if (line >= 0 && position?.scroll !== Number.MAX_SAFE_INTEGER) {
        const scroll = ui.detail.scrollTop + anchor.node.y + line - ui.detail.viewport.y - anchor.row
        prepend = undefined
        position = { sessionID: state.selected, history: state.history, scroll: Math.max(0, scroll) }
        restorePosition()
        return
      }
    }
    textAnchor = undefined
    if (position?.scroll === Number.MAX_SAFE_INTEGER || atBottom()) return
    function capture(node: Renderable): boolean {
      if (!node.visible) return false
      if (node instanceof TextBufferRenderable && node.y + node.height > ui.detail.viewport.y) {
        const line = Math.max(0, ui.detail.viewport.y - node.y)
        const info = node.lineInfo
        if (info.lineSources[line] !== undefined && node.y + line < ui.detail.viewport.y + ui.detail.viewport.height) {
          textAnchor = {
            node,
            width: node.width,
            source: info.lineSources[line]!,
            column: info.lineStartCols[line]!,
            row: node.y + line - ui.detail.viewport.y,
          }
          return true
        }
      }
      return node.getChildren().some(capture)
    }
    capture(ui.detail.content)
  }

  function atBottom() {
    return ui.detail.scrollTop + ui.detail.viewport.height >= ui.detail.scrollHeight - 1
  }

  function commitPrepend() {
    if (!prepend) return
    if (position) position.scroll = ui.detail.scrollTop
    prepend = undefined
  }

  function currentView() {
    const key = `${state.tab}:${state.selected}:${state.history}:${stagedMessageID() ?? ""}`
    if (key !== viewKey) {
      viewKey = key
      generation++
      prepend = undefined
      textAnchor = undefined
    }
    return generation
  }

  function stagedMessageID() {
    return state.snapshot?.sessions.find((session) => session.id === state.selected)?.revert?.messageID
  }

  function mergeLive(messages: NonNullable<DashboardState["detail"]>["messages"], older = false) {
    const id = state.selected
    const boundary = stagedMessageID()
    const previous = live.get(id)
    const cached: LivePage =
      previous?.boundary === boundary && previous
        ? previous
        : {
            messages: [],
            capped: false,
            expanded: false,
            cursor: state.detail?.cursor.next ?? undefined,
            boundary,
          }
    const incoming = messages.map((message) => ({
      id: message.id,
      formatted: transcript([message]),
      raw: transcript([message], true),
    }))
    if (
      !older &&
      incoming.length &&
      cached.messages.length &&
      !incoming.some((item) => cached.messages.some((previous) => previous.id === item.id))
    ) {
      cached.messages = []
      cached.cursor = state.detail?.cursor.next ?? undefined
      cached.capped = false
      generation++
      hooks.say("Recent messages moved beyond cached history. Scroll up to reload; h opens full History.")
    }
    const merged = new Map(
      (older ? [...incoming, ...cached.messages] : [...cached.messages, ...incoming]).map((item) => [item.id, item]),
    )
    cached.messages = [...merged.values()]
    let size = cached.messages.reduce((sum, item) => sum + Math.max(item.formatted.length, item.raw.length) + 2, 0)
    while (cached.messages.length > 1 && (cached.messages.length > 120 || size > 80000)) {
      const removed = cached.messages.shift()!
      size -= Math.max(removed.formatted.length, removed.raw.length) + 2
      cached.capped = true
    }
    live.delete(id)
    live.set(id, cached)
    if (size > 80000) cached.capped = true
    if (live.size > 5) {
      const evicted = live.keys().next().value!
      live.delete(evicted)
      positions.delete(evicted)
    }
    return cached
  }

  function syncLayout() {
    try {
      const root = (ui.root.parent ?? ui.root) as any
      if (typeof root?.calculateLayout === "function") {
        root.calculateLayout()
      } else if (typeof root?.getLayoutNode === "function") {
        root.getLayoutNode()?.calculateLayout(root.width ?? 80, root.height ?? 24, 1)
      }
      const detail = ui.detail as any
      if (detail) {
        detail._lastLayoutFrame = -1
        detail.updateFromLayout?.()
        if (detail.content) {
          detail.content._lastLayoutFrame = -1
          detail.content.updateFromLayout?.()
        }
        if (detail.viewport) {
          detail.viewport._lastLayoutFrame = -1
          detail.viewport.updateFromLayout?.()
        }
        detail.recalculateBarProps?.()
      }
    } catch {
      // Safe fallback: layout will sync on next frame render
    }
  }

  function drawLive() {
    const cached = live.get(state.selected)
    const question = hooks.questionsInPanel ? "" : pendingQuestions(state.detail?.questions ?? [])
    const notice = cached?.capped ? "Live scrollback limit reached. Press h, then [ for further history.\n\n" : ""
    const boundary = stagedMessageID()
    const point = boundary ? (cached?.messages.findIndex((message) => message.id === boundary) ?? -1) : -1
    const visible = boundary ? cached?.messages.slice(0, Math.max(0, point)) : cached?.messages
    const staged = boundary ? "UNDO STAGED - a new reply commits this point; /redo restores later turns.\n\n" : ""
    const content =
      visible
        ?.slice(cached?.expanded ? 0 : -6)
        .map((item) => (state.rawResponses ? item.raw : item.formatted))
        .join("\n\n") ||
      (boundary ? "Earlier history is outside this recent window. Press h to inspect history." : "No messages yet.")
    ui.renderContent(`${question ? `${question}\n\n` : ""}${staged}${notice}${content}`, !question)
    syncLayout()
    restorePosition()
  }

  function rememberPosition() {
    if (state.tab !== "sessions" || !state.selected || state.modal?.inline) return
    if (state.detail?.sessionID !== state.selected) return
    const saved = positions.get(state.selected) ?? { history: state.history, latest: 0, transcript: 0 }
    saved.history = state.history
    if (state.history) saved.cursor = state.historyCursor
    saved[state.history ? "transcript" : "latest"] = prepend
      ? ui.detail.scrollTop
      : (position?.scroll ?? ui.detail.scrollTop)
    positions.delete(state.selected)
    positions.set(state.selected, saved)
    if (positions.size > 256) positions.delete(positions.keys().next().value!)
  }

  function loadPosition() {
    generation++
    textAnchor = undefined
    prepend = undefined
    pageRequest = undefined
    beforeQuestion = undefined
    if (state.detail && state.detail.sessionID !== state.selected) state.detail = undefined
    const saved = positions.get(state.selected)
    state.history = saved?.history ?? false
    state.historyCursor = saved?.cursor
    position = {
      sessionID: state.selected,
      history: state.history,
      scroll: saved?.[state.history ? "transcript" : "latest"] ?? Number.MAX_SAFE_INTEGER,
    }
    if (!state.history && live.has(state.selected)) {
      drawLive()
    } else {
      ui.detail.scrollTo(0)
    }
  }

  function hasLive(id: string) {
    return live.has(id)
  }

  function cancelPosition() {
    currentView()
    textAnchor = undefined
    prepend = undefined
    position = undefined
    beforeQuestion = undefined
    // Docked reply paging bypasses the dashboard's scrollEarlier handler.
    if (state.modal?.docked && state.modal.editor) void scrollEarlier()
  }

  function restorePosition() {
    if (
      state.closed ||
      !position ||
      state.tab !== "sessions" ||
      state.selected !== position.sessionID ||
      state.history !== position.history ||
      (state.detail && state.detail.sessionID !== position.sessionID) ||
      state.modal?.inline
    )
      return
    // Markdown may report several intermediate heights while rebuilding blocks.
    // Reapply the prefix delta until the next input or poll commits the anchor.
    ui.detail.scrollTo(
      prepend ? Math.max(0, prepend.scroll + ui.detail.scrollHeight - prepend.height) : position.scroll,
    )
  }
  ui.detail.content.on("resize", restorePosition)
  ui.detail.viewport.on("resize", restorePosition)
  ui.detail.onMouse = (event) => {
    if (["scroll", "down", "drag"].includes(event.type)) cancelPosition()
    if (event.type === "scroll" && event.scroll?.direction === "up") void scrollEarlier()
  }
  // Slider-specific handlers stop propagation; keep them and observe input first.
  ui.detail.verticalScrollBar.slider.onMouse = (event) => {
    if (["down", "drag"].includes(event.type)) cancelPosition()
  }

  async function render() {
    if (disposed) return
    currentView()
    const version = ++state.detailVersion
    if (loading) await loading
    if (disposed || version !== state.detailVersion || state.closed) return
    loading = load(version)
      .then(() => {
        if (disposed || version !== state.detailVersion || state.closed) return
        if (error) hooks.clearNotice(error)
        error = ""
        hooks.actions()
      })
      .catch((cause) => {
        if (disposed || version !== state.detailVersion || state.closed) return
        pageRequest = undefined
        state.detail = undefined
        ui.renderContent(`Details unavailable: ${errorText(cause)}\n\nPress r to retry.`)
        error = `Details unavailable: ${errorText(cause)}`
        hooks.say(error, true)
        hooks.actions()
      })
      .finally(() => {
        loading = undefined
      })
    return loading
  }

  async function load(version: number) {
    const id = state.selected
    const snapshot = state.snapshot
    if (!snapshot || state.closed) return
    ui.sessionTitle.fg = color.text
    const inventoryError = state.tab === "sessions" ? "" : snapshot.inventoryErrors[state.tab]
    if (inventoryError) {
      state.detail = undefined
      ui.context.visible = false
      ui.sessionTitle.content = state.tab === "terminals" ? "Terminal inventory unavailable" : "Automations unavailable"
      ui.renderContent(`${inventoryError}\n\nPress r to retry. Sessions remain available: press 1.`)
      return
    }
    if (!id) {
      ui.context.visible = false
      state.detail = undefined
      ui.renderContent(
        state.query
          ? state.tab === "sessions" && snapshot.more
            ? "No matching recent or active sessions.\nOlder sessions are not loaded.\nPress / to change the filter."
            : "No matching items. Press / to change the filter."
          : state.tab === "sessions"
            ? welcomeBody("sessions", state)
            : state.tab === "terminals" && !snapshot.terminalsAvailable
              ? "Global terminal inventory is unavailable on this server version.\n\nUpdate the server to inspect terminal processes.\nSessions and agent launch are available."
              : `No ${state.tab} found.`,
      )
      ui.sessionTitle.content = "Welcome to TurenOS"
      return
    }
    if (state.tab === "terminals") {
      state.detail = undefined
      const item = snapshot.terminals.find((item) => item.id === id)
      if (!item) return
      ui.context.content = `${label(item.status)} · ${label(item.cwd, 250)}`
      ui.sessionTitle.content = "Terminal process"
      ui.renderContent(
        display(
          `PID ${item.pid}  ·  ${item.status}${item.exitCode !== undefined ? `  ·  exit ${item.exitCode}` : ""}\n\n${item.title}\n${item.cwd}\n\n$ ${[item.command, ...item.args].join(" ")}\n\n${item.id}\n\n${item.status === "running" ? "Enter attaches (Ctrl+] detaches) · " : ""}a new terminal · R rename · d close`,
        ),
      )
      return
    }
    if (state.tab === "automations") {
      state.detail = undefined
      const item = snapshot.loops.find((item) => item.id === id)
      if (!item) return
      ui.context.content = `${label(item.status)} · ${label(item.location.directory, 250)}`
      const triggerDetails = item.eventTrigger
        ? `Trigger: ${scheduleText(item.schedule, item.eventTrigger)}\nSchedule: ${scheduleText(item.schedule)}`
        : scheduleText(item.schedule)
      const overview = display(
        `${item.name} · ${item.status}\n\n${item.location.directory}\n${triggerDetails}\nNext run: ${typeof item.nextRunAt === "number" ? new Date(item.nextRunAt).toLocaleString() : "unscheduled"}\n\n${item.prompt}\n\n${item.id}\n\nEnter manage (run now, pause, edit, runs) · a new · E edit · d delete`,
      )
      ui.renderContent(overview)
      const runs = await connection.runs(id).catch((error: unknown) => errorText(error))
      if (version !== state.detailVersion || state.closed) return
      ui.renderContent(
        `${overview}\n\nRECENT RUNS\n${
          typeof runs === "string"
            ? `Run history unavailable: ${runs}\nPress r to retry.`
            : runs
                .slice(0, 10)
                .map((run) => `${label(run.status)} · ${label(run.id)}`)
                .join("\n") || "No runs yet."
        }`,
      )
      return
    }
    const session = snapshot.sessions.find((session) => session.id === id)
    if (!session) return
    if (state.detail?.sessionID !== id) {
      state.detail = undefined
      if (!live.has(id) || state.history) {
        ui.renderContent(`Loading ${display(session.title)}…`)
      }
    }
    ui.sessionTitle.content = label(session.title || "Untitled session", 150)
    ui.context.visible = !state.modal?.inline
    ui.context.fg = color.muted
    ui.context.content = `${state.history ? "History" : "Transcript"}${Object.hasOwn(snapshot.active, id) ? " · Working" : ""} · ${label(session.location.directory, 250)}`
    const page = state.history && pageRequest?.sessionID === id ? pageRequest : undefined
    const result = await connection.detail(id, state.history ? (page?.cursor ?? state.historyCursor) : undefined)
    if (version !== state.detailVersion || state.closed) return
    if (page) {
      pageRequest = undefined
      // The API supplies cursors even at boundaries. Do not replace the last
      // readable page with an empty result or lose the way back.
      if (!result.messages.length) {
        hooks.say(page.direction === "next" ? "Start of history reached." : "Newest history page.")
        return
      }
      state.historyCursor = page.cursor
      position = { sessionID: id, history: true, scroll: 0 }
      ui.detail.scrollTo(0)
    }
    if (!state.history && hooks.project) result.messages = [...hooks.project(id, result.messages)]
    state.detail = result
    state.modal?.refresh?.()
    const tasks = [...new Map([...result.tasks.data, ...result.tasks.active].map((task) => [task.id, task])).values()]
    if (tasks.length) {
      const active = tasks.filter((task) => ["queued", "starting", "running"].includes(task.status)).length
      const failed = tasks.filter((task) => task.status === "failed").length
      ui.context.content = `${state.history ? "History" : "Transcript"} · Tasks: ${active} active, ${failed} failed · ${label(session.location.directory, 150)}`
    }
    if (result.permissions.length || result.questions.length) {
      ui.context.content = `Needs input · ${label(session.location.directory, 250)}`
      ui.context.fg = color.warning
    }
    commitPrepend()
    const pendingKey = `${id}:${result.permissions[0]?.id ?? ""}:${result.questions[0]?.id ?? ""}`
    if (pendingKey !== lastPending) {
      lastPending = pendingKey
      if (result.questions.length && !hooks.questionsInPanel) {
        beforeQuestion ??= position ?? {
          sessionID: id,
          history: state.history,
          scroll:
            !state.history && ui.detail.scrollTop + ui.detail.viewport.height >= ui.detail.scrollHeight - 1
              ? Number.MAX_SAFE_INTEGER
              : ui.detail.scrollTop,
        }
        position = { sessionID: id, history: state.history, scroll: 0 }
      } else if (beforeQuestion?.sessionID === id) {
        position = beforeQuestion
        beforeQuestion = undefined
      }
      if (result.permissions.length || result.questions.length) hooks.say("Needs input · p permission · o question")
    }
    hooks.actions()
    const questionPreview = hooks.questionsInPanel ? "" : pendingQuestions(result.questions)
    const follow =
      !state.history &&
      !questionPreview &&
      (position?.scroll === Number.MAX_SAFE_INTEGER ||
        (!position && ui.detail.scrollTop + ui.detail.viewport.height >= ui.detail.scrollHeight - 1))
    if (follow) position = { sessionID: id, history: false, scroll: Number.MAX_SAFE_INTEGER }
    if (!state.history) {
      mergeLive(result.messages)
      drawLive()
    } else {
      const content = transcript(result.messages, state.rawResponses) || "No messages yet."
      const staged = stagedMessageID()
        ? "UNDO STAGED - this History view includes later, staged-away messages.\n\n"
        : ""
      ui.renderContent(`${questionPreview ? `${questionPreview}\n\n` : ""}${staged}${content}`, !questionPreview)
      syncLayout()
      restorePosition()
    }
  }

  async function scrollEarlier() {
    const token = currentView()
    const id = state.selected
    const cached = live.get(id)
    if (
      earlier ||
      state.closed ||
      (state.modal && !state.modal.docked) ||
      state.detail?.questions.length ||
      state.tab !== "sessions" ||
      state.history ||
      state.detail?.sessionID !== id ||
      !cached
    )
      return
    if (!cached.expanded && cached.messages.length > 6) {
      // Let the triggering key/wheel movement finish before measuring its anchor.
      earlier = Promise.resolve()
        .then(() => {
          if (
            token !== currentView() ||
            state.closed ||
            (state.modal && !state.modal.docked) ||
            state.detail?.sessionID !== id ||
            state.detail.questions.length
          )
            return
          cached.expanded = true
          const follow = position?.scroll === Number.MAX_SAFE_INTEGER || (!position && atBottom())
          prepend = follow ? undefined : { height: ui.detail.scrollHeight, scroll: ui.detail.scrollTop }
          position = { sessionID: id, history: false, scroll: follow ? Number.MAX_SAFE_INTEGER : ui.detail.scrollTop }
          drawLive()
        })
        .finally(() => {
          earlier = undefined
        })
      return earlier
    }
    cached.expanded = true
    // Preserve/reveal the local reading window while composing, without paging remotely.
    if (state.modal) return
    if (ui.detail.scrollTop > Math.max(10, ui.detail.viewport.height)) return
    if (cached.capped) return hooks.say("Live scrollback limit reached. Press h, then [ for further history.")
    const cursor = cached.cursor
    if (!cursor) return
    const valid = () =>
      !state.closed &&
      token === currentView() &&
      state.selected === id &&
      !state.history &&
      state.tab === "sessions" &&
      !state.modal &&
      state.detail?.sessionID === id &&
      !state.detail.questions.length
    earlier = (async () => {
      try {
        const result = await connection.client.messages.list({ sessionID: id, limit: 30, cursor })
        if (!valid()) return
        // End (or scrolling to the bottom) while fetching must remain following.
        const follow = position?.scroll === Number.MAX_SAFE_INTEGER || (!position && atBottom())
        // Capture after the request: the user's triggering scroll has now applied.
        const anchor = { height: ui.detail.scrollHeight, scroll: ui.detail.scrollTop }
        const updated = mergeLive(result.data.toReversed(), true)
        updated.cursor =
          result.data.length && result.cursor.next !== cursor ? (result.cursor.next ?? undefined) : undefined
        position = { sessionID: id, history: false, scroll: follow ? Number.MAX_SAFE_INTEGER : anchor.scroll }
        prepend = follow ? undefined : anchor
        drawLive()
        if (!result.data.length) hooks.say("Start of history reached.")
      } catch (cause) {
        if (valid()) hooks.say(`Earlier messages unavailable: ${errorText(cause)}. Scroll up to retry.`, true)
      } finally {
        earlier = undefined
      }
    })()
    return earlier
  }

  function toggleHistory() {
    if (state.tab !== "sessions" || !state.selected) return hooks.say("Select a session first.")
    rememberPosition()
    pageRequest = undefined
    state.history = !state.history
    currentView()
    state.detail = undefined
    position = {
      sessionID: state.selected,
      history: state.history,
      scroll: positions.get(state.selected)?.[state.history ? "transcript" : "latest"] ?? 0,
    }
    state.historyCursor = state.history ? positions.get(state.selected)?.cursor : undefined
    ui.detail.scrollTo(0)
    hooks.actions()
    void render()
  }

  function updateLive(messages: MessagesListOutput["data"]) {
    if (
      state.closed ||
      state.tab !== "sessions" ||
      state.history ||
      state.modal?.inline ||
      state.detail?.sessionID !== state.selected ||
      stagedMessageID()
    )
      return
    commitPrepend()
    const follow =
      (!state.detail.questions.length || hooks.questionsInPanel) &&
      (position?.scroll === Number.MAX_SAFE_INTEGER ||
        (!position && ui.detail.scrollTop + ui.detail.viewport.height >= ui.detail.scrollHeight - 1))
    if (follow) position = { sessionID: state.selected, history: false, scroll: Number.MAX_SAFE_INTEGER }
    state.detail.messages = [...messages]
    mergeLive(state.detail.messages)
    drawLive()
    hooks.actions()
  }

  function invalidateSession(sessionID: string) {
    live.delete(sessionID)
    positions.delete(sessionID)
    if (state.selected !== sessionID) return
    ++state.detailVersion
    ++generation
    textAnchor = undefined
    state.detail = undefined
    state.historyCursor = undefined
    pageRequest = undefined
    position = undefined
    prepend = undefined
    beforeQuestion = undefined
    ui.renderContent("Refreshing conversation history…")
  }

  function invalidateAll() {
    live.clear()
    positions.clear()
    if (state.selected) invalidateSession(state.selected)
  }

  function page(direction: "next" | "previous") {
    if (
      pageRequest ||
      state.modal ||
      state.tab !== "sessions" ||
      !state.history ||
      state.detail?.sessionID !== state.selected
    )
      return
    const cursor = state.detail.cursor[direction]
    if (!cursor) return hooks.say(direction === "next" ? "Start of history reached." : "Newest history page.")
    pageRequest = { sessionID: state.selected, cursor, direction }
    hooks.say("Loading history page…")
    void render()
  }

  function dispose() {
    disposed = true
    ++state.detailVersion
    generation++
    live.clear()
    ui.detail.renderAfter = renderAfter
    textAnchor = undefined
    ui.detail.content.off("resize", restorePosition)
    ui.detail.viewport.off("resize", restorePosition)
  }

  return {
    render,
    updateLive,
    invalidateSession,
    invalidateAll,
    rememberPosition,
    loadPosition,
    hasLive,
    cancelPosition,
    scrollEarlier,
    toggleHistory,
    page,
    dispose,
    get error() {
      return error
    },
  }
}
