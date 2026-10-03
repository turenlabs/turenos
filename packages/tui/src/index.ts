import {
  createCliRenderer,
  fg,
  t,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
} from "@opentui/core"
import { connect, errorText, type Connection, type ConnectionOptions, type Session } from "./server"
import { display } from "./messages"
import { color } from "./theme"
import { headerLeft, headerRight, promptBoxText, scheduleText, sidebarTitle, statusline, welcomeBody } from "./chrome"
import { createDashboardState, label, type Tab } from "./state"
import { createLayout } from "./layout"
import { createDialogs } from "./dialogs"
import { createLaunch } from "./launch"
import { createRequests } from "./requests"
import { createConversation } from "./conversation"
import { createMenus } from "./menus"
import { createModels } from "./models"
import { createSessionActions, todoProgress } from "./session-actions"
import { activityFrame } from "./activity"
import { matchesKey, printableKey } from "./keys"
import { sessionRows, type SidebarRow } from "./session-list"
import { folderContains } from "./working-folders"
import { createCopyControls } from "./copy"
import { createSlashCommands } from "./slash"
import { createMentions } from "./mentions"
import { createSessionControls } from "./session-controls"
import { createLiveSession } from "./live-session"
import { createRewindControls } from "./rewind"
import { createModelVariants } from "./model-variants"
import { createGoalControls } from "./goal-controls"
import { createHarnessControls } from "./harness"
import { createQueueControls, waiting } from "./queue"
import { contextUsage, createContextLimits, meterText } from "./context-meter"
import { createChanges } from "./changes"
import { createFiles } from "./files"
import { createTerminals } from "./terminals"
import { createSwarmRoom } from "./swarm"
import { createAutomations } from "./automations"
import { createExtensions } from "./extensions"
import { createMemories } from "./memories"
import { createSettings } from "./settings"
import { createIntel } from "./intel"
import { createInspect } from "./inspect"
import { settleTerminalInput } from "./terminal-exit"
import { createServers, serverLabel, type Endpoint, type Servers, type Target } from "./servers"
import { createServerPicker } from "./server-picker"
import { CliError } from "./tui-auth"

/**
 * Without a URL the client opens the local TurenOS (desktop app, then this host's own servers),
 * and `s` switches servers at any time. `directory` applies only to the first server.
 */
export async function runTui(options: Omit<ConnectionOptions, "url"> & { url?: string; server?: string }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The TurenOS TUI requires an interactive terminal.")
  const servers = createServers({ username: options.username })
  await servers.load()
  const explicit = options.url
    ? ({
        kind: "url",
        id: "cli",
        name: new URL(options.url).host,
        url: new URL(options.url).origin,
        saved: false,
      } as const)
    : undefined
  if (explicit && options.password) servers.remember(explicit, options.password)
  const initial = explicit ?? (options.server ? servers.find(options.server) : await servers.preferred())
  if (options.server && !initial) throw new CliError({ message: `No saved server named ${options.server}.` })
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, backgroundColor: color.bg })
  let app: ReturnType<typeof mountApp> | undefined
  try {
    await new Promise<void>((resolve) => {
      renderer.once("destroy", resolve)
      app = mountApp(renderer, servers, {
        initial,
        directory: options.directory,
        onQuit: () =>
          void settleTerminalInput(renderer).then(
            () => renderer.destroy(),
            () => renderer.destroy(),
          ),
      })
    })
  } finally {
    app?.dispose()
    renderer.destroy()
  }
}

/** The server picker plus one dashboard for the connected server, swapped as the user switches. */
export function mountApp(
  renderer: CliRenderer,
  servers: Servers,
  options: { initial?: Target; directory?: string; onQuit: () => void },
) {
  let current: { dashboard: Dashboard; endpoint: Endpoint } | undefined
  let directory = options.directory
  const picker = createServerPicker(renderer, servers, {
    current: () => current && { target: current.endpoint.target, connected: current.dashboard.connected() },
    drafts: () => current?.dashboard.drafts() ?? 0,
    connect: async (target, signal, progress) => {
      const endpoint = await servers.resolve(target, { signal, progress })
      if (signal.aborted) {
        endpoint.close?.()
        throw new Error("Connection cancelled.")
      }
      const connection = connect({
        url: endpoint.url,
        username: endpoint.username,
        password: endpoint.password,
        directory,
      })
      // Mount before disposing the current dashboard, so a failed switch leaves it untouched.
      let dashboard: Dashboard
      try {
        dashboard = mountDashboard(renderer, connection, endpoint.url, finish, {
          server: serverLabel(endpoint.target),
          servers: () => picker.open(),
          blocked: picker.visible,
        })
      } catch (error) {
        connection.close()
        endpoint.close?.()
        throw error
      }
      directory = undefined
      const previous = current
      current = { endpoint, dashboard }
      previous?.dashboard.dispose()
      previous?.endpoint.close?.()
      void servers.importDesktop(endpoint)
    },
    closed: () => current?.dashboard.focus(),
    quit: finish,
  })

  function dispose() {
    picker.close(false)
    current?.dashboard.dispose()
    current?.endpoint.close?.()
    current = undefined
    servers.stopHeadless()
  }

  function finish() {
    dispose()
    options.onQuit()
  }

  if (options.initial) picker.start(options.initial)
  else
    picker.open(
      servers.problems().join(" ") ||
        "TurenOS is not running on this computer. Open the TurenOS app, start a private server, or choose another server.",
      "warning",
    )
  return { picker, dashboard: () => current?.dashboard, dispose }
}

type DashboardOptions = {
  /** The connected server, shown in the header. */
  server?: string
  /** Opens the server picker; its absence hides server switching. */
  servers?: () => void
  /** True while another surface, such as the server picker, owns the keyboard. */
  blocked?: () => boolean
}

export function mountDashboard(
  renderer: CliRenderer,
  connection: Connection,
  address: string,
  onQuit = () => renderer.destroy(),
  options: DashboardOptions = {},
) {
  const state = createDashboardState()
  state.serverSwitching = !!options.servers
  let timer: ReturnType<typeof setTimeout> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let noticeMessage = ""
  let refreshing: Promise<void> | undefined
  let renderingList = false
  let activityTimer: ReturnType<typeof setInterval> | undefined
  let activityStep = 0
  let quitArmedUntil = 0
  let disposed = false
  const serverAddress = options.server ? `${options.server} · ${address}` : address
  const views = new Map<Tab, { selected: string; query: string }>()
  const ui = createLayout(renderer, state)
  ui.serversButton.visible = !!options.servers
  const limits = createContextLimits(connection, () => renderActions())
  const copy = createCopyControls(renderer, state, say)
  ui.detail.onMouseDown = copy.rightClick
  const conversation = createConversation(state, connection, ui, {
    questionsInPanel: true,
    actions: renderActions,
    say,
    clearNotice: (message) => {
      if (noticeMessage === message) say("")
    },
    project: (sessionID, messages) => live.project(sessionID, messages),
  })
  const live = createLiveSession(state, connection, {
    paint: conversation.updateLive,
    snapshot: (metadata) => {
      if (metadata) void refresh()
      else void conversation.render()
    },
    status: renderActions,
    invalidate: (sessionID) => {
      if (sessionID) conversation.invalidateSession(sessionID)
      else conversation.invalidateAll()
    },
  })
  const dialogs = createDialogs(renderer, state, ui, {
    rememberPosition: conversation.rememberPosition,
    cancelPosition: conversation.cancelPosition,
    changed: (reload) => {
      renderActions()
      resize()
      if (reload) void conversation.render()
    },
    submitted: async () => {
      // Join any pre-mutation read before requesting a fresh snapshot.
      if (refreshing) await refreshing
      await refresh()
    },
    say,
    recall: () => {
      if (state.detail?.sessionID !== state.selected) return
      const previous = state.detail.messages
        .toReversed()
        .find((message) => message.type === "user" && (!message.source || message.source === "user"))
      return previous?.type === "user" ? previous.text : undefined
    },
  })
  const slash = createSlashCommands(
    renderer,
    state,
    connection,
    slashCommands,
    (name, dialog, editor) => {
      const action = slashCommands().find((item) => item.name === name)
      if (!action) return
      if (
        [
          "compact",
          "undo",
          "redo",
          "goal",
          "harness",
          "queued",
          "delete",
          "changes",
          "files",
          "terminal",
          "room",
        ].includes(name) &&
        dialog.inline
      )
        return say(`Start this new session before using /${name}.`)
      editor.setText("")
      if (name === "model" && dialog.chooseModel) return dialog.chooseModel()
      if (name === "editor") return void dialogs.compose()
      if (name === "agent" && dialog.chooseAgent) return dialog.chooseAgent()
      if ((name === "effort" || name === "variant") && dialog.chooseVariant) return dialog.chooseVariant()
      dialog.save?.()
      dialogs.close(false)
      action.run()
    },
    dialogs.resize,
  )
  const mentions = createMentions(renderer, state, connection, dialogs.resize)
  const requests = createRequests(renderer, state, connection, dialogs, say, openSession, slash, mentions)
  const rewind = createRewindControls(renderer, state, connection, dialogs, say, {
    blocked: requests.replyBlocked,
    restoreDraft: requests.restoreDraft,
    clearRestoredDraft: requests.clearRestoredDraft,
    changed: (session) => {
      if (state.snapshot)
        state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? session : item))
      if (state.inspected?.id === session.id) state.inspected = session
      requests.updateRecipient(session)
      live.invalidate(session.id)
      conversation.invalidateSession(session.id)
    },
  })
  const controls = createSessionControls(
    renderer,
    state,
    connection,
    dialogs,
    say,
    requests.updateRecipient,
    requests.replyBlocked,
  )
  const variants = createModelVariants(
    renderer,
    state,
    connection,
    dialogs,
    say,
    requests.updateRecipient,
    requests.replyBlocked,
  )
  const goals = createGoalControls(renderer, state, connection, dialogs, say, requests.replyBlocked)
  const harness = createHarnessControls(renderer, state, connection, dialogs, say, requests.replyBlocked)
  const queue = createQueueControls(renderer, state, connection, dialogs, say, {
    blocker: requests.restoreBlocker,
    restore: requests.restoreDraft,
    reply: requests.followup,
  })
  const drafts = { mention: requests.mention, reply: requests.followup }
  const changes = createChanges(renderer, state, connection, dialogs, say, drafts)
  const files = createFiles(renderer, state, connection, dialogs, say, drafts)
  const terminals = createTerminals(renderer, state, connection, dialogs, say, refresh)
  const room = createSwarmRoom(renderer, state, connection, dialogs, say)
  const automations = createAutomations(renderer, state, connection, dialogs, say, openSession)
  const extensions = createExtensions(
    renderer,
    state,
    connection,
    dialogs,
    () =>
      state.snapshot?.sessions.find((item) => item.id === state.selected)?.location.directory ??
      state.snapshot?.location.directory ??
      "/",
  )
  const memories = createMemories(renderer, state, connection, dialogs, say)
  const intel = createIntel(renderer, state, connection, dialogs, say)
  const inspect = createInspect(renderer, state, connection, dialogs, say)
  const settings = createSettings(renderer, state, connection, dialogs, say, {
    connectProvider: () => models.connect(),
    extensions: extensions.open,
    memories: (back) => void memories.open(back),
    servers: options.servers ? servers : undefined,
    appearance: () => [
      { name: state.reducedMotion ? "Turn animation on" : "Reduce motion", run: toggleMotion },
      {
        name: state.rawResponses ? "Show formatted responses" : "Show raw responses",
        description: "Tool results and agent updates in the transcript",
        run: toggleRaw,
      },
    ],
  })
  const models = createModels(
    renderer,
    state,
    connection,
    dialogs,
    say,
    requests.updateRecipient,
    requests.replyBlocked,
  )
  const launch = createLaunch(renderer, state, connection, dialogs, say, openSession, models, slash, variants, mentions)
  const sessions = createSessionActions(
    renderer,
    state,
    connection,
    dialogs,
    say,
    openSession,
    requests.updateRecipient,
    (id) => {
      requests.forget(id)
      if (state.inspected?.id === id) state.inspected = undefined
      if (state.snapshot) state.snapshot.sessions = state.snapshot.sessions.filter((item) => item.id !== id)
      if (state.selected !== id) return
      state.selected = ""
      state.detail = undefined
    },
  )
  const menus = createMenus(renderer, state, dialogs, connection, {
    launch: launch.open,
    openSession,
    hasDraft: requests.hasDraft,
  })

  function resize() {
    ui.resize()
    renderTabs()
    renderStatus()
    // The server picker owns focus while it is open; taking it back would send its input here.
    if (!options.blocked?.()) ui.focus()
    renderActivity()
  }

  function renderActivity() {
    if (state.closed) return
    const current = activityFrame(state, activityStep, state.reducedMotion)
    ui.activity.visible = !!current && !state.modal?.inline && !ui.sizeNotice.visible
    ui.activity.content = current?.content ?? ""
    ui.activity.fg = color[current?.tone ?? "muted"]
    if (current?.animate && ui.activity.visible && !activityTimer)
      activityTimer = setInterval(() => {
        activityStep++
        renderActivity()
      }, 100)
    if ((!current?.animate || !ui.activity.visible) && activityTimer) {
      clearInterval(activityTimer)
      activityTimer = undefined
    }
  }

  function renderStatus() {
    ui.heading.content = renderer.width < 90 ? "TurenOS" : headerLeft(state.snapshot)
    const dot = fg(state.connected ? color.added : state.connectionError ? color.error : color.warning)
    ui.server.content = options.server ? t`${dot(state.connected ? "●" : "○")} ${label(options.server, 120)}` : ""
    ui.running.content = headerRight(state, state.snapshot)
    ui.footer.content = statusline(state, state.snapshot, renderer.width)
    ui.status.visible = !state.connected
    if (state.connected) return
    if (state.snapshot && state.tab === "sessions" && !state.selected && !state.query && !state.modal?.inline)
      ui.renderContent(welcomeBody("sessions", state))
    ui.status.content = state.connectionError
      ? `Disconnected${state.snapshot ? " · showing saved data" : ""} · retrying · i Details`
      : "Connecting…"
  }

  function say(message: string, error = false) {
    if (state.closed) return
    ui.notice.content = `${message && error ? "! " : ""}${display(message, 1000)}`
    noticeMessage = message
    ui.notice.visible = !!message
    ui.notice.fg = error ? color.error : color.muted
    if (noticeTimer) clearTimeout(noticeTimer)
    if (message && !error)
      noticeTimer = setTimeout(() => {
        noticeMessage = ""
        ui.notice.visible = false
      }, 5000)
  }

  function renderTabs() {
    for (const [index, { tab, button, name }] of ui.tabButtons.entries()) {
      button.content = `${state.tab === tab ? "> " : ""}${renderer.width >= 90 ? ["1 Chat", "2 Term", "3 Auto"][index] : name}  `
      button.fg = state.tab === tab ? color.accent : color.muted
      button.attributes = state.tab === tab ? TextAttributes.BOLD : TextAttributes.NONE
    }
  }

  function renderList() {
    renderTabs()
    const snapshot = state.snapshot
    if (!snapshot) return
    const rows: SidebarRow[] =
      state.tab === "sessions"
        ? sessionRows(
            snapshot.sessions.filter(
              (session) =>
                snapshot.workingFolders === undefined ||
                snapshot.workingFolders.some((folder) => folderContains(folder, session.location.directory)) ||
                state.selected === session.id ||
                state.modal?.recipient?.id === session.id,
            ),
            snapshot.active,
          ).map((row) => {
            const session = snapshot.sessions.find((session) => session.id === row.id)!
            return snapshot.workingFolders !== undefined &&
              !snapshot.workingFolders.some((folder) => folderContains(folder, session.location.directory))
              ? { ...row, groupLabel: `${row.groupLabel} (closed)` }
              : row
          })
        : state.tab === "terminals"
          ? snapshot.terminals.map((terminal) => ({
              id: terminal.id,
              name: `[${label(terminal.status)}] ${label(terminal.title)}`,
              description: `PID ${terminal.pid} · ${label(terminal.cwd, 250)}`,
            }))
          : snapshot.loops.map((loop) => ({
              id: loop.id,
              name: `[${label(loop.status)}] ${label(loop.name)}`,
              description: `${scheduleText(loop.schedule, loop.eventTrigger)} · ${label(loop.location.directory, 250)}`,
            }))
    const filtered = rows.filter((row) =>
      state.tab === "sessions" && state.inspection && state.query === state.inspection
        ? row.id === state.inspection
        : `${row.name} ${row.description} ${row.id}`.toLowerCase().includes(state.query.toLowerCase()),
    )
    state.rows = filtered
    const index = state.rows.findIndex(
      (row) =>
        row.id ===
        (state.selected ||
          (state.tab === "sessions"
            ? (snapshot.sessions.find((session) => !session.parentID) ?? snapshot.sessions[0])?.id
            : "")),
    )
    const selected = state.rows[Math.max(0, index)]?.id ?? ""
    if (state.selected !== selected) {
      conversation.rememberPosition()
      state.selected = selected
      if (state.tab === "sessions") conversation.loadPosition()
    }
    renderingList = true
    ui.list.options = filtered
    if (state.rows.length) ui.list.setSelectedIndex(Math.max(0, index), false)
    renderingList = false
    ui.sidebarHeading.content = sidebarTitle(state, state.rows.length)
    ui.folders.content = ` Working folders${snapshot.workingFolders ? ` · ${snapshot.workingFolders.length}` : ""}${snapshot.folderError ? " !" : ""}`
    const emptyFolders = (snapshot.workingFolders ?? []).filter(
      (directory) => !snapshot.sessions.some((session) => folderContains(directory, session.location.directory)),
    )
    ui.emptyFolders.visible = state.tab === "sessions" && emptyFolders.length > 0
    ui.emptyFolders.height = Math.min(3, emptyFolders.length)
    ui.emptyFolders.content = emptyFolders
      .slice(0, 3)
      .map((directory) => `${label(directory, 250)} (no recent sessions)`)
      .join("\n")
    ui.heading.content = renderer.width < 90 ? "TurenOS" : headerLeft(snapshot)
    ui.running.content = headerRight(state, snapshot)
    renderActions()
  }

  function renderActions() {
    renderActivity()
    ui.sidebarActions.content = ` + ${launch.hasDraft ? "Resume draft" : "New session"}    n\n / ${state.query && state.query !== state.inspection ? `Find: ${label(state.query, 18)}` : `Find ${state.tab === "sessions" ? "a session" : "items"}`}`
    const pending = state.detail?.sessionID === state.selected ? state.detail : undefined
    const reply = promptBoxText(state, pending, {
      hasDraft: requests.hasDraft(state.selected),
    })
    const primary =
      conversation.error && state.connected
        ? "r Retry details"
        : requests.replyBlocked(state.selected) && !pending?.permissions.length && !pending?.questions.length
          ? "f Owning session (read-only)"
          : reply
    const staged = state.snapshot?.sessions.find((session) => session.id === state.selected)?.revert
    ui.composer.content = `${primary}${staged ? " · commits undo" : ""} · Enter`
    ui.composer.fg =
      !state.connected || pending?.permissions.length || pending?.questions.length ? color.warning : color.text
    ui.composer.visible = !state.connected || (state.tab === "sessions" && !!state.selected)
    ui.history.visible = state.tab === "sessions" && !!state.selected
    ui.harness.visible = ui.history.visible
    ui.changes.visible = ui.history.visible
    ui.files.visible = ui.history.visible
    ui.history.content = state.history ? "h Live" : "h History"
    const todos = todoProgress(pending?.todos ?? [])
    ui.tasks.visible = !!pending && (pending.tasks.data.length > 0 || pending.tasks.active.length > 0 || !!todos)
    ui.tasks.content = `t Tasks${todos ? ` · ${todos}` : ""}`
    const queued = waiting(pending?.pending).length
    ui.queued.visible = queued > 0
    ui.queued.content = `u ${queued} queued`
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    const usage = pending && !state.history ? contextUsage(pending.messages) : undefined
    ui.meter.content = session && usage ? meterText(usage, limits(session.location.directory, usage.model)) : ""
    ui.meter.visible = !!ui.meter.content
    ui.historyActions.visible = state.tab === "sessions" && state.history && !!state.selected && !state.modal?.inline
    ui.older.fg = pending?.cursor.next ? color.accent : color.muted
    ui.newer.fg = pending?.cursor.previous ? color.accent : color.muted
    ui.historyCount.content = pending
      ? `${pending.messages.length} messages${pending.cursor.next ? "" : " · start"}`
      : "Loading…"
    ui.footer.content = statusline(state, state.snapshot, renderer.width)
    queueMicrotask(() => {
      if (!ui.sizeNotice.visible && !options.blocked?.()) requests.offerQuestion()
    })
  }

  async function refresh() {
    if (state.closed) return
    refreshing ??= update().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  async function update() {
    if (timer) clearTimeout(timer)
    try {
      const snapshot = await connection.snapshot()
      if (state.closed) return
      if (state.inspected && !snapshot.sessions.some((session) => session.id === state.inspected!.id))
        snapshot.sessions.push(state.inspected)
      const recipient = state.modal?.recipient
      if (recipient && !snapshot.sessions.some((session) => session.id === recipient.id))
        snapshot.sessions.push(recipient)
      for (const saved of requests.savedSessions()) {
        if (!snapshot.sessions.some((session) => session.id === saved.id)) snapshot.sessions.push(saved)
      }
      state.snapshot = snapshot
      state.connected = true
      state.connectionError = ""
      ui.status.fg = color.muted
      renderStatus()
      renderList()
      if (!state.modal?.inline) await conversation.render()
    } catch (error) {
      if (state.closed) return
      state.connected = false
      state.connectionError = errorText(error)
      state.detail = undefined
      ++state.detailVersion
      ui.status.fg = color.error
      renderStatus()
      renderActions()
      if (!state.snapshot)
        ui.renderContent(
          errorText(error).includes("Authentication required")
            ? "Authentication required.\n\nSet FORGE_SERVER_PASSWORD to the server's password and restart the TUI.\nUse --username if the server has a custom username."
            : `Could not connect to the server.\n\n${errorText(error)}\n\nPress r to retry.`,
        )
    } finally {
      if (!state.closed) timer = setTimeout(() => void refresh(), 2000)
    }
  }

  function changeTab(tab: Tab) {
    quitArmedUntil = 0
    if (state.searching || !dialogs.navigate()) return
    conversation.rememberPosition()
    views.set(state.tab, { selected: state.selected, query: state.query })
    state.tab = tab
    state.selected = views.get(tab)?.selected ?? ""
    state.detail = undefined
    state.history = false
    ++state.detailVersion
    state.query = views.get(tab)?.query ?? ""
    ui.detail.scrollTo(0)
    renderList()
    if (tab === "sessions") conversation.loadPosition()
    if (tab !== "sessions") conversation.cancelPosition()
    void conversation.render()
  }

  function openSession(id: string, inspect = false, session?: Session) {
    quitArmedUntil = 0
    if (state.closed) return
    if (!inspect && !session && !state.snapshot?.sessions.some((item) => item.id === id)) {
      void connection.client.sessions
        .get({ sessionID: id })
        .then((fetched) => {
          if (!state.closed) openSession(id, false, fetched)
        })
        .catch((error: unknown) => {
          if (!state.closed) say(`Cannot open session ${id}: ${errorText(error)}`, true)
        })
      return
    }
    conversation.rememberPosition()
    state.workingDirectory = undefined
    if (state.tab !== "sessions") views.set(state.tab, { selected: state.selected, query: state.query })
    if (state.tab === "sessions" && state.selected && state.selected !== id) state.previousSession = state.selected
    state.searching = undefined
    ui.search.visible = false
    ui.search.value = ""
    state.query = inspect ? id : ""
    state.inspection = inspect ? id : ""
    state.inspected = session
    if (session && state.snapshot && !state.snapshot.sessions.some((item) => item.id === id))
      state.snapshot.sessions.push(session)
    state.tab = "sessions"
    state.selected = id
    state.detail = undefined
    ++state.detailVersion
    conversation.loadPosition()
    state.detailFocused = true
    if (!conversation.hasLive(id) || inspect || state.tab !== "sessions") {
      ui.renderContent(inspect ? "Loading the attempted session…" : "Loading session…")
    }
    renderList()
    resize()
    if (!state.modal?.inline) void conversation.render()
    if (!inspect) return
    void refresh()
    say("Looking up the attempted session. n resumes draft; / changes search.")
    void connection.client.sessions
      .get({ sessionID: id })
      .then((session) => {
        if (state.closed || state.tab !== "sessions" || state.inspection !== id || state.query !== id) return
        state.inspected = session
        if (state.snapshot && !state.snapshot.sessions.some((item) => item.id === id))
          state.snapshot.sessions.push(session)
        state.selected = id
        renderList()
        if (!state.modal?.inline) void conversation.render()
        if (!state.modal) say("Attempted session selected. n resumes draft; / changes search.")
      })
      .catch((error) => {
        if (state.closed || state.tab !== "sessions" || state.inspection !== id || state.query !== id) return
        say(`Cannot inspect this session: ${errorText(error)} Draft kept; n resumes.`, true)
        ui.renderContent(
          `Could not look up session ${id}.\n\n${errorText(error)}\n\nYour draft is kept. Press n to resume and inspect or retry.`,
        )
      })
  }

  function hop(direction: number) {
    if (!dialogs.navigate()) return
    const sessions = state.snapshot?.sessions ?? []
    if (!sessions.length) return
    const index = sessions.findIndex((session) => session.id === state.selected)
    const next =
      index < 0 ? (direction > 0 ? 0 : sessions.length - 1) : (index + direction + sessions.length) % sessions.length
    openSession(sessions[next]!.id)
  }

  function filter() {
    if (!dialogs.navigate()) return
    if (state.tab === "sessions") return menus.switcher("recent", true)
    state.searching = { query: state.query, selected: state.selected }
    state.sidebarHidden = false
    ui.search.value = state.query
    ui.search.visible = true
    resize()
    say("Type to search · ↑/↓ choose · Enter open · Esc cancel")
  }

  const onPress = (action: () => void) => (event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    quitArmedUntil = 0
    action()
  }
  ui.switchButton.onMouseDown = onPress(() => menus.switcher())
  ui.server.onMouseDown = onPress(servers)
  ui.serversButton.onMouseDown = onPress(servers)
  ui.folders.onMouseDown = onPress(() => menus.workingFolders())
  ui.modelButton.onMouseDown = onPress(() => {
    if (state.modal) {
      if (!state.modal.busy) state.modal.chooseModel?.()
      return
    }
    models.open()
  })
  for (const { tab, button } of ui.tabButtons) button.onMouseDown = onPress(() => changeTab(tab))
  ui.sidebarActions.onMouseDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    quitArmedUntil = 0
    if (event.y === ui.sidebarActions.y) launch.open()
    if (event.y === ui.sidebarActions.y + 1) filter()
  }
  function primaryAction() {
    if (state.modal) return
    if (!state.connected || conversation.error) return void refresh()
    if (state.tab === "terminals") return state.selected ? terminals.open() : terminals.create()
    if (state.tab === "automations") return state.selected ? automations.manage() : automations.create()
    if (state.tab !== "sessions" || !state.selected) return launch.open()
    const pending = state.detail?.sessionID === state.selected ? state.detail : undefined
    if (pending?.permissions.length) return requests.permission()
    if (pending?.questions.length) return requests.question()
    requests.followup()
  }
  ui.composer.onMouseDown = onPress(primaryAction)
  ui.history.onMouseDown = onPress(() => {
    if (!state.modal) conversation.toggleHistory()
  })
  ui.older.onMouseDown = onPress(() => conversation.page("next"))
  ui.newer.onMouseDown = onPress(() => conversation.page("previous"))
  ui.information.onMouseDown = onPress(() => {
    if (!state.modal) menus.information(serverAddress)
  })
  ui.tasks.onMouseDown = onPress(() => {
    if (!state.modal) sessions.tasks()
  })
  ui.harness.onMouseDown = onPress(() => {
    if (!state.modal) harness.open()
  })
  ui.queued.onMouseDown = onPress(() => {
    if (!state.modal) queue.open()
  })
  ui.changes.onMouseDown = onPress(() => {
    if (!state.modal) changes.open()
  })
  ui.files.onMouseDown = onPress(() => {
    if (!state.modal) files.open()
  })
  ui.search.on("input", () => {
    if (!state.searching) return
    state.query = ui.search.value
    renderList()
    state.detail = undefined
    void conversation.render()
  })
  ui.list.on("selectionChanged", (index: number) => {
    if (renderingList) return
    quitArmedUntil = 0
    const id = state.rows[index]?.id ?? ""
    if (id === state.selected) return
    if (!dialogs.navigate()) {
      ui.list.setSelectedIndex(
        Math.max(
          0,
          state.rows.findIndex((row) => row.id === state.selected),
        ),
      )
      state.modal?.fields[state.modal.index]?.focus()
      return
    }
    conversation.rememberPosition()
    if (state.tab === "sessions") state.previousSession = state.selected
    state.selected = id
    conversation.loadPosition()
    renderActions()
    state.detail = undefined
    if (!conversation.hasLive(id) || state.tab !== "sessions") {
      ui.renderContent("Loading session…")
    }
    void conversation.render()
  })
  ui.list.on("itemSelected", () => {
    if (state.modal) return
    state.detailFocused = true
    ui.focus()
  })

  ui.list.on("focused", () => {
    const dialog = state.modal
    if (dialog) (dialog.fields[dialog.index] ?? dialog.form).focus()
  })

  function slashCommands() {
    return [
      { name: "help", description: "Keyboard help", run: menus.help },
      { name: "new", description: "New session", run: launch.open },
      { name: "sessions", description: "Find a session", run: menus.switcher },
      { name: "model", description: "Choose a model", run: models.open },
      { name: "editor", description: "Compose the message in $EDITOR", run: () => void dialogs.compose() },
      { name: "effort", description: "Choose model effort / variant", run: variants.open },
      { name: "variant", description: "Choose model effort / variant", run: variants.open },
      { name: "agent", description: "Choose session agent", run: controls.agent },
      { name: "goal", description: "Inspect and control the session goal", run: goals.open },
      { name: "harness", description: "Session harness: tools, guidance, reviewer proposals", run: harness.open },
      { name: "queued", description: "Send now, edit, or discard queued messages", run: queue.open },
      { name: "changes", description: "Review uncommitted, branch, or last-turn changes", run: changes.open },
      { name: "files", description: "Browse and read the session's files", run: files.open },
      { name: "terminal", description: "Open the session's shared terminal", run: () => void terminals.shared() },
      { name: "room", description: "Swarm room: lanes, entries, post as a human", run: room.open },
      {
        name: "settings",
        description: "Providers, usage, extensions, memories, agents, permissions",
        run: settings.open,
      },
      { name: "extensions", description: "Skills, MCP servers, and data sources", run: () => extensions.open() },
      { name: "memories", description: "What agents remember across sessions", run: () => void memories.open() },
      { name: "intel", description: "Advisories, known-exploited CVEs, and security news", run: intel.open },
      {
        name: "tools",
        description: "Tools and MCP servers this session's agent can use",
        run: () => void inspect.tools(),
      },
      { name: "trace", description: "Page through this session's event log", run: inspect.trace },
      { name: "compact", description: "Confirm context summarization", run: controls.compact },
      { name: "undo", description: "Stage a reversible conversation rewind", run: rewind.undo },
      { name: "redo", description: "Restore the next staged turn", run: rewind.redo },
      { name: "history", description: "Toggle expanded history", run: conversation.toggleHistory },
      { name: "tasks", description: "Tasks and subagents", run: sessions.tasks },
      { name: "subagents", description: "Browse delegated tasks", run: sessions.tasks },
      { name: "rename", description: "Rename session", run: sessions.rename },
      { name: "delete", description: "Delete session and its subagents", run: sessions.remove },
      { name: "info", description: "Session and server details", run: () => menus.information(serverAddress) },
      { name: "details", description: "Session and server details", run: () => menus.information(serverAddress) },
      { name: "folders", description: "Manage working folders", run: () => menus.workingFolders() },
      ...(options.servers ? [{ name: "servers", description: "Switch TurenOS server", run: servers }] : []),
      { name: "stop", description: "Confirm interruption", run: requests.interrupt },
      { name: "kill", description: "Interrupt session and cancel its tasks", run: requests.kill },
      { name: "stop-all", description: "Stop every running agent on this server", run: requests.stopAll },
      { name: "commands", description: "All TUI actions", run: commands },
    ]
  }

  function commands() {
    menus.commands([
      { name: "Switch session", description: "Ctrl+K", run: menus.switcher },
      ...(options.servers ? [{ name: "Switch server", description: "s", run: servers }] : []),
      { name: "Browse all sessions", description: "Server title search", run: () => menus.switcher("all") },
      {
        name: "Working folders",
        description: "Open or close folders shared with the GUI",
        run: () => menus.workingFolders(),
      },
      { name: "Browse archived sessions", description: "Restore older work", run: () => menus.switcher("archived") },
      { name: "Open session by ID", description: "Includes older sessions", run: menus.openByID },
      { name: "Next session", description: "Alt+Right", run: () => hop(1) },
      { name: "Previous session", description: "Alt+Left", run: () => hop(-1) },
      { name: "New session", description: "n", run: launch.open },
      { name: "Rename session", description: "Change the selected title", run: sessions.rename },
      { name: "Archive / restore session", description: "Hide or restore history", run: sessions.archive },
      { name: "Delete session", description: "Permanently, with its subagents", run: sessions.remove },
      { name: "Tasks and subagents", description: "Ctrl+X / t", run: sessions.tasks },
      { name: "Go to parent session", description: "Open parent", run: sessions.parent },
      { name: "Choose model for this session", description: "m", run: models.open },
      { name: "Choose model effort / variant", description: "/effort", run: variants.open },
      { name: "Session goal", description: "/goal", run: goals.open },
      { name: "Session harness", description: "H / /harness", run: harness.open },
      { name: "Choose agent for this session", description: "/agent", run: controls.agent },
      { name: "Compact session context", description: "/compact", run: controls.compact },
      { name: "Undo conversation turn", description: "/undo", run: rewind.undo },
      { name: "Redo conversation turn", description: "/redo", run: rewind.redo },
      { name: "Connect provider / add custom model", description: "API key or OAuth", run: models.connect },
      { name: "Sessions", description: "1", run: () => changeTab("sessions") },
      { name: "Terminal processes", description: "2", run: () => changeTab("terminals") },
      { name: "Automations", description: "3", run: () => changeTab("automations") },
      { name: "Send follow-up", description: "f", run: requests.followup },
      { name: "Queued messages", description: "u · send now, edit, or discard", run: queue.open },
      { name: "Review changes", description: "d · uncommitted, branch, last turn", run: changes.open },
      { name: "Browse files", description: "e · read files, @ mention in reply", run: files.open },
      { name: "Open session terminal", description: "T · shared with the agent", run: () => void terminals.shared() },
      { name: "Swarm room", description: "w · subagent lanes and messages", run: room.open },
      { name: "New automation", description: "a in Automations", run: automations.create },
      {
        name: "Manage automation",
        description: "Enter in Automations · run, pause, edit, runs",
        run: automations.manage,
      },
      { name: "Settings", description: ", · providers, usage, extensions, memories", run: settings.open },
      { name: "Extensions", description: "Skills, MCP servers, data sources", run: () => extensions.open() },
      { name: "Memories", description: "Wings, rooms, and notes agents recall", run: () => void memories.open() },
      { name: "Intel", description: "I · advisories, KEV, security news", run: intel.open },
      {
        name: "Session tools",
        description: "/tools · built-in, MCP, and excluded tools",
        run: () => void inspect.tools(),
      },
      { name: "Session trace", description: "/trace · the session's event log", run: inspect.trace },
      { name: "New terminal", description: "a in Terminals", run: terminals.create },
      { name: "Attach to terminal", description: "Enter in Terminals · Ctrl+] detaches", run: terminals.open },
      { name: "Rename terminal", description: "R in Terminals", run: terminals.rename },
      { name: "Close terminal", description: "d in Terminals", run: terminals.close },
      { name: "Review permission", description: "p", run: requests.permission },
      { name: "Answer question", description: "o", run: requests.question },
      { name: "Reject question", description: "Confirm without answering", run: () => requests.question(true) },
      { name: "Interrupt session", description: "x", run: requests.interrupt },
      { name: "Kill session", description: "Interrupt and cancel its tasks", run: requests.kill },
      { name: "Stop all agents", description: "Kill switch for this server", run: requests.stopAll },
      { name: "Search items", description: "/", run: filter },
      { name: "Refresh", description: "r", run: () => void refresh() },
      { name: "Keyboard help", description: "?", run: menus.help },
      { name: "Copy selected text", description: "Ctrl+Y / right-click", run: copy.copySelection },
      { name: "Toggle terminal mouse selection", description: "F6 / native right-click menu", run: copy.toggleMouse },
      { name: "Session history / live transcript", description: "h", run: conversation.toggleHistory },
      {
        name: state.rawResponses ? "Show formatted responses" : "Show raw responses",
        description: "Tool results and agent updates",
        run: toggleRaw,
      },
      { name: "Older history page", description: "[ in History", run: () => conversation.page("next") },
      { name: "Newer history page", description: "] in History", run: () => conversation.page("previous") },
      { name: "Session and connection details", description: "i", run: () => menus.information(serverAddress) },
      { name: "Toggle sidebar", description: "b / Ctrl+B", run: toggleSidebar },
      {
        name: "Toggle reduced motion",
        description: state.reducedMotion ? "Animation off" : "Animation on",
        run: toggleMotion,
      },
      { name: "Quit dashboard", description: "q / Ctrl+C", run: quit },
    ])
  }

  function toggleRaw() {
    state.rawResponses = !state.rawResponses
    void conversation.render()
    say(state.rawResponses ? "Raw responses on." : "Formatted responses on.")
  }

  function toggleMotion() {
    state.reducedMotion = !state.reducedMotion
    renderActivity()
    say(state.reducedMotion ? "Reduced motion on." : "Reduced motion off.")
  }

  function toggleSidebar() {
    state.sidebarHidden = ui.sidebar.visible
    resize()
  }

  function quit() {
    if (Date.now() < quitArmedUntil) return close()
    if (state.modal?.busy) {
      quitArmedUntil = Date.now() + 3000
      return say("Request still running. Ctrl+C again quits; server work may continue.")
    }
    if (state.modal) {
      const draft = !!state.modal.save
      dialogs.close()
      if (!draft) return
      quitArmedUntil = Date.now() + 3000
      return say("Draft kept. Ctrl+C again quits and discards saved drafts.")
    }
    if (launch.hasDraft || requests.savedSessions().length) {
      quitArmedUntil = Date.now() + 3000
      return say("Unsent drafts are saved locally. Press q or Ctrl+C again to quit and discard them.")
    }
    close()
  }

  function close() {
    if (state.closed) return
    state.closed = true
    onQuit()
  }

  function servers() {
    if (!options.servers || state.modal?.busy) return
    quitArmedUntil = 0
    options.servers()
  }

  function paste(event: PasteEvent) {
    if (!options.blocked?.()) dialogs.paste(event)
  }

  function keypress(key: KeyEvent) {
    if (state.closed) return key.preventDefault()
    if (options.blocked?.()) return
    if (key.hyper || key.eventType === "release") return key.preventDefault()
    if (matchesKey(key, "c", { ctrl: true })) {
      key.preventDefault()
      return quit()
    }
    if (printableKey(key) !== "q") quitArmedUntil = 0
    if (copy.key(key)) {
      key.preventDefault()
      return
    }
    if (ui.sizeNotice.visible) {
      key.preventDefault()
      if (!key.shift && printableKey(key) === "q") quit()
      return
    }
    if (matchesKey(key, "k", { ctrl: true }) && state.modal?.questionKey) {
      key.preventDefault()
      return menus.switcher()
    }
    if (matchesKey(key, "n", { ctrl: true }) && (!state.modal || state.modal.editor)) {
      key.preventDefault()
      return launch.open()
    }
    if (slash.key(key)) {
      key.preventDefault()
      return
    }
    if (mentions.key(key)) {
      key.preventDefault()
      return
    }
    if (dialogs.keypress(key)) return
    if (state.searching) {
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        key.preventDefault()
        if (key.name === "up") ui.list.moveUp()
        if (key.name === "down") ui.list.moveDown()
        return
      }
      if (!matchesKey(key, "escape") && !matchesKey(key, "enter")) return
      key.preventDefault()
      if (key.name === "escape") {
        state.query = state.searching.query
        state.selected = state.searching.selected
        renderList()
      }
      state.searching = undefined
      ui.search.visible = false
      state.detailFocused = matchesKey(key, "enter")
      say(state.query ? `Search: ${label(state.query)} · / change or clear` : "")
      ui.focus()
      void conversation.render()
      return
    }
    if (matchesKey(key, "k", { ctrl: true })) {
      key.preventDefault()
      return menus.switcher()
    }
    if (matchesKey(key, "left", { meta: true }) || matchesKey(key, "right", { meta: true })) {
      key.preventDefault()
      return hop(key.name === "left" ? -1 : 1)
    }
    if (matchesKey(key, "p", { ctrl: true })) {
      key.preventDefault()
      return commands()
    }
    if (matchesKey(key, "x", { ctrl: true })) {
      key.preventDefault()
      return sessions.tasks()
    }
    if (matchesKey(key, "b", { ctrl: true })) {
      key.preventDefault()
      return toggleSidebar()
    }
    if (
      ["pageup", "pagedown"].some((name) => matchesKey(key, name)) ||
      (state.detailFocused && ["up", "down", "home", "end", "j", "k"].some((name) => matchesKey(key, name)))
    )
      conversation.cancelPosition()
    if (matchesKey(key, "pageup") || (state.detailFocused && ["up", "home", "k"].some((name) => matchesKey(key, name))))
      void conversation.scrollEarlier()
    if (printableKey(key) === "H") {
      key.preventDefault()
      return harness.open()
    }
    if (printableKey(key) === "T") {
      key.preventDefault()
      return void terminals.shared()
    }
    if (printableKey(key) === "I") {
      key.preventDefault()
      return intel.open()
    }
    // The list tabs have their own add / delete / rename keys.
    const tabActions: Record<string, () => void> =
      state.tab === "terminals"
        ? { a: terminals.create, d: terminals.close, R: terminals.rename }
        : state.tab === "automations"
          ? { a: automations.create, d: automations.remove, E: automations.edit }
          : {}
    const tabAction = tabActions[printableKey(key) ?? ""]
    if (tabAction) {
      key.preventDefault()
      return tabAction()
    }
    // Consume shortcuts before moving focus so they do not enter the new field.
    const character = key.shift && key.sequence !== "?" ? "" : printableKey(key)
    if (
      [
        "q",
        "n",
        "m",
        "f",
        "p",
        "o",
        "x",
        "h",
        "i",
        "t",
        "u",
        "d",
        "e",
        "w",
        ",",
        "[",
        "]",
        "/",
        "1",
        "2",
        "3",
        "r",
        "?",
        "b",
      ].includes(character) ||
      (character === "s" && options.servers)
    )
      key.preventDefault()
    if (character === "s" && options.servers) return servers()
    if (character === "?") return menus.help()
    if (character === "q") return quit()
    if (character === "n") return launch.open()
    if (character === "m") return models.open()
    if (character === "f") return requests.followup()
    if (character === "t") return sessions.tasks()
    if (character === "u") return queue.open()
    if (character === "d") return changes.open()
    if (character === "e") return files.open()
    if (character === "w") return room.open()
    if (character === ",") return settings.open()
    if (character === "p") return requests.permission()
    if (character === "o") return requests.question()
    if (character === "x") return requests.interrupt()
    if (character === "h") return conversation.toggleHistory()
    if (character === "[") return conversation.page("next")
    if (character === "]") return conversation.page("previous")
    if (character === "i") return menus.information(serverAddress)
    if (character === "/") {
      if (state.tab !== "sessions" || !state.detailFocused || !state.selected) return filter()
      if (requests.replyBlocked(state.selected))
        return menus.commands([
          { name: "/main", description: "Open owning session and reply", run: requests.followup },
          ...slashCommands().map((item) => ({ ...item, name: `/${item.name}` })),
        ])
      requests.followup()
      const editor = state.modal?.editor
      if (!editor) return
      if (!editor.plainText) {
        editor.setText("/")
        editor.cursorOffset = 1
      } else say("Draft kept unchanged. Type / in an empty editor for commands.")
      return
    }
    if (character === "1") return changeTab("sessions")
    if (character === "2") return changeTab("terminals")
    if (character === "3") return changeTab("automations")
    if (character === "r") return void refresh()
    if (character === "b") return toggleSidebar()
    if (matchesKey(key, "enter") && ui.list.focused) {
      key.preventDefault()
      return ui.list.selectCurrent()
    }
    if (matchesKey(key, "enter") && state.detailFocused) {
      key.preventDefault()
      return primaryAction()
    }
    if (matchesKey(key, "tab") || matchesKey(key, "tab", { shift: true })) {
      key.preventDefault()
      state.detailFocused = !state.detailFocused
      return ui.focus()
    }
    if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
      key.preventDefault()
      ui.detail.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, ui.detail.viewport.height - 1))
    }
  }

  // Releases everything this dashboard holds so another can mount on the same renderer.
  function dispose() {
    if (disposed) return
    disposed = true
    state.closed = true
    live.dispose()
    if (timer) clearTimeout(timer)
    if (noticeTimer) clearTimeout(noticeTimer)
    if (activityTimer) clearInterval(activityTimer)
    connection.close()
    renderer.keyInput.off("keypress", keypress)
    renderer.keyInput.off("paste", paste)
    renderer.off("resize", resize)
    renderer.off("destroy", dispose)
    conversation.dispose()
    if (!renderer.isDestroyed) ui.root.destroyRecursively()
  }

  renderer.on("resize", resize)
  renderer.keyInput.on("keypress", keypress)
  renderer.keyInput.on("paste", paste)
  renderer.once("destroy", dispose)
  resize()
  renderList()
  live.start()
  const ready = refresh()
  return {
    ready,
    refresh,
    dispose,
    connected: () => state.connected,
    drafts: () =>
      (launch.hasDraft ? 1 : 0) + requests.savedSessions().length + (state.modal?.editor?.plainText.trim() ? 1 : 0),
    focus() {
      const dialog = state.modal
      if (dialog) return (dialog.fields[dialog.index] ?? dialog.form).focus()
      ui.focus()
    },
  }
}

export type Dashboard = ReturnType<typeof mountDashboard>
