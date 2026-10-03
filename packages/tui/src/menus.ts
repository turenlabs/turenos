import {
  BoxRenderable,
  InputRenderable,
  RenderableEvents,
  SelectRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { display } from "./messages"
import { label, type DashboardState } from "./state"
import { color } from "./theme"
import type { Dialogs } from "./dialogs"
import { errorText, type Connection, type Session } from "./server"
import { identifier } from "./response-validation"
import { matchesKey } from "./keys"
import { sessionRows } from "./session-list"
import { folderContains } from "./working-folders"

export function createMenus(
  renderer: CliRenderer,
  state: DashboardState,
  dialogs: Dialogs,
  connection: Connection,
  actions: {
    launch: () => void
    openSession: (id: string, inspect?: boolean, session?: Session) => void
    hasDraft: (id: string) => boolean
  },
) {
  function openByID(value = "") {
    const dialog = dialogs.open("Open session by ID", false, 17)
    if (!dialog) return
    const input = dialogs.input(dialog, "Session ID (including older sessions)", value, "ses_...")
    input.maxLength = 256
    dialog.submit = async () => {
      const id = input.value.trim()
      try {
        identifier(id, "ses_")
      } catch {
        throw new Error("Enter a valid session ID beginning with ses_. Find it in web session details or a saved link.")
      }
      if (!state.connected) throw new Error("Reconnect before looking up a session.")
      const session = await connection.client.sessions.get({ sessionID: id })
      if (state.closed) return
      actions.openSession(session.id, false, session)
    }
    dialog.error.content = "Ctrl+S / Enter Open · Esc cancel\nLooks up this ID on the connected server."
    dialog.key = (key) => {
      if (!matchesKey(key, "enter")) return false
      void dialogs.submit()
      return true
    }
    input.focus()
  }

  function switcher(initialScope: "recent" | "all" | "archived" = "recent", sidebar = false) {
    if (!dialogs.navigate()) return
    const sessions = [...(state.snapshot?.sessions ?? [])]
      .filter(
        (session) =>
          !sidebar ||
          state.snapshot?.workingFolders === undefined ||
          state.snapshot.workingFolders.some((folder) => folderContains(folder, session.location.directory)),
      )
      .sort(
        (a, b) =>
          Number(b.id === state.previousSession) - Number(a.id === state.previousSession) ||
          Number(!!a.parentID) - Number(!!b.parentID),
      )
    const dialog = dialogs.open("Switch session", false, 32, false, sidebar)
    if (!dialog) return
    dialog.frame.maxWidth = 160
    dialog.frame.maxHeight = undefined
    let scope = initialScope
    let remote: Session[] = []
    let cursors: { next?: string | null; previous?: string | null } = {}
    let loading = false
    let failure = ""
    let version = 0
    let searchTimer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const query = new InputRenderable(renderer, {
      placeholder: "Search title, project, agent, or session ID…",
      maxLength: 256,
      width: "100%",
      flexShrink: 0,
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
      placeholderColor: color.muted,
    })
    dialog.frame.add(query, 0)
    dialogs.track(dialog, query)
    const scopes = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 2 })
    const scopeButtons = (["recent", "all", "archived"] as const).map((value) => {
      const button = new TextRenderable(renderer, {
        content: value,
        fg: color.muted,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          if (!dialog.busy) changeScope(value)
        },
      })
      scopes.add(button)
      return { value, button }
    })
    scopes.add(new TextRenderable(renderer, { content: "F2", fg: color.muted }))
    dialog.frame.add(scopes, 1)
    const create = () => {
      dialogs.close(false)
      actions.launch()
    }
    dialog.frame.add(
      new TextRenderable(renderer, {
        content: "+ New session  Ctrl+N",
        fg: color.accent,
        height: 1,
        flexShrink: 0,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          create()
        },
      }),
      2,
    )
    let matches = sessions
    let selected = 0
    let rows: TextRenderable[] = []
    let headings: TextRenderable[] = []
    let offsets: number[] = []
    const details = new TextRenderable(renderer, {
      content: "",
      height: 4,
      flexShrink: 0,
      fg: color.muted,
      wrapMode: "word",
    })
    dialog.frame.add(details, 3)
    const describe = () => {
      if (state.closed || state.modal !== dialog || details.isDestroyed) return
      details.visible = !sidebar && renderer.width >= 110 && renderer.height >= 32
      const session = matches[selected]
      details.content = session
        ? `${label(session.title || "Untitled session", 256)}\n${label(session.location.directory, 256)}\n${label(session.agent ?? "Default agent")} · ${session.id}`
        : ""
    }
    renderer.on("resize", describe)
    details.once(RenderableEvents.DESTROYED, () => renderer.off("resize", describe))
    const reveal = () => {
      // Include project headings even before replacement rows have been laid out.
      const top = offsets[selected] ?? 0
      if (top < dialog.form.scrollTop) dialog.form.scrollTo(top)
      if (top + 1 > dialog.form.scrollTop + dialog.form.viewport.height)
        dialog.form.scrollTo(top + 1 - dialog.form.viewport.height)
    }
    const paint = (index: number) => {
      const session = matches[index]
      const row = rows[index]
      if (!session || !row) return
      row.bg = index === selected ? color.accent : color.panel
      row.fg = index === selected ? color.bg : color.text
      const markers = `${session.id === state.selected ? " | current" : ""}${Object.hasOwn(state.snapshot?.active ?? {}, session.id) ? " *" : ""}${actions.hasDraft(session.id) ? " [draft]" : ""}${session.time.archived !== undefined && scope !== "archived" ? " [archived]" : ""}`
      row.content = `${index === selected ? "> " : "  "}${label(session.title || "Untitled session", 150)}${session.parentID ? " [child]" : ""}${markers}`
    }
    const choose = (index: number) => {
      const previous = selected
      selected = Math.max(0, Math.min(index, matches.length - 1))
      paint(previous)
      paint(selected)
      describe()
      reveal()
      dialog.error.content = loading
        ? "Searching server...\nEsc cancel"
        : failure
          ? `${failure}\nF3 Retry · Esc close`
          : scope === "recent"
            ? matches.length
              ? `${selected + 1}/${matches.length} · ↑/↓ choose · Enter open · Esc close\nType to find children · F2 All · Ctrl+O ID${details.visible ? " · PgUp/Dn page · Ctrl+Home/End first/last" : ""}`
              : query.value.trim()
                ? "No matching loaded sessions.\nF2 Search server · Ctrl+O Open older session by ID"
                : "No loaded main sessions.\nType to find children · F2 All · Ctrl+O ID"
            : `${matches.length ? `${selected + 1}/${matches.length}` : "No matching titles"} · Enter open · Esc close\nF3 Older · Shift+F3 Newer · F2 Scope`
    }
    const open = (index = selected) => {
      if (loading || dialog.busy) return
      const session = matches[index]
      if (!session) return
      if (
        scope !== "recent" ||
        (state.snapshot?.workingFolders !== undefined &&
          !state.snapshot.workingFolders.some((folder) => folderContains(folder, session.location.directory)))
      ) {
        choose(index)
        void dialogs.submit()
        return
      }
      dialogs.close(false)
      actions.openSession(session.id, false, session)
    }
    const update = () => {
      const id = matches[selected]?.id
      const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
      matches =
        scope !== "recent"
          ? remote
          : sessions.filter((session) => {
              if (!terms.length && session.parentID) return false
              const text =
                `${session.title} ${session.agent ?? ""} ${session.location.directory} ${session.id}`.toLowerCase()
              return terms.every((term) => text.includes(term))
            })
      matches = [...matches].sort(
        (a, b) =>
          a.location.directory.localeCompare(b.location.directory, undefined, { numeric: true }) ||
          (a.location.workspaceID ?? "").localeCompare(b.location.workspaceID ?? ""),
      )
      const groups = new Map(sessionRows(matches, {}).map((row) => [row.id, row]))
      selected = Math.max(
        0,
        matches.findIndex((session) => session.id === id),
      )
      rows.forEach((row) => row.destroyRecursively())
      headings.forEach((heading) => heading.destroyRecursively())
      headings = []
      offsets = []
      let offset = 0
      rows = matches.map((session, index) => {
        const previous = matches[index - 1]
        if (
          !previous ||
          previous.location.directory !== session.location.directory ||
          previous.location.workspaceID !== session.location.workspaceID
        ) {
          const heading = new TextRenderable(renderer, {
            content: groups.get(session.id)!.groupLabel,
            fg: color.muted,
            height: 1,
            flexShrink: 0,
            width: "100%",
            wrapMode: "none",
            truncate: true,
          })
          dialog.form.add(heading)
          headings.push(heading)
          offset++
        }
        offsets.push(offset++)
        const row = new TextRenderable(renderer, {
          height: 1,
          flexShrink: 0,
          width: "100%",
          wrapMode: "none",
          truncate: true,
          onMouseDown: (event) => {
            event.preventDefault()
            if (event.button === 0) open(index)
          },
        })
        dialog.form.add(row)
        return row
      })
      rows.forEach((_, index) => paint(index))
      choose(selected)
    }
    dialog.submit = async () => {
      const session = matches[selected]
      if (loading || !session) throw new Error("Choose a loaded session first.")
      const current = await connection.client.sessions.get({ sessionID: session.id })
      if (
        state.snapshot?.workingFolders !== undefined &&
        !state.snapshot.workingFolders.some((folder) => folderContains(folder, current.location.directory))
      )
        state.snapshot.workingFolders = await connection.folders.open(current.location.directory)
      if (!state.closed) actions.openSession(current.id, false, current)
    }
    const search = async (cursor?: string) => {
      if (searchTimer) clearTimeout(searchTimer)
      controller?.abort()
      controller = new AbortController()
      const requestVersion = ++version
      loading = true
      failure = ""
      choose(selected)
      try {
        if (!state.connected) throw new Error("Reconnect before searching the server.")
        const page = await connection.searchSessions(
          { search: query.value.trim() || undefined, archived: scope === "archived", cursor },
          controller.signal,
        )
        if (state.closed || state.modal !== dialog || version !== requestVersion) return
        if (cursor && !page.data.length) {
          loading = false
          choose(selected)
          dialog.error.content = "End of results; current page kept.\nF3 Older · Shift+F3 Newer · Esc close"
          return
        }
        remote = [...page.data]
        cursors = page.cursor
        loading = false
        update()
      } catch (error) {
        if (state.closed || state.modal !== dialog || version !== requestVersion) return
        loading = false
        failure = errorText(error)
        choose(selected)
      }
    }
    function changeScope(value: typeof scope) {
      if (searchTimer) clearTimeout(searchTimer)
      controller?.abort()
      ++version
      scope = value
      remote = []
      cursors = {}
      failure = ""
      loading = false
      for (const item of scopeButtons) {
        item.button.content =
          item.value === scope
            ? `[${item.value === "all" ? "All sessions" : item.value === "archived" ? "Archived" : "Recent"}]`
            : item.value === "all"
              ? "All sessions"
              : item.value === "archived"
                ? "Archived"
                : "Recent"
        item.button.fg = item.value === scope ? color.accent : color.muted
      }
      query.placeholder =
        scope === "recent" ? "Search title, project, agent, or session ID…" : "Search server by title…"
      update()
      if (scope !== "recent") void search()
    }
    query.on("input", () => {
      if (scope === "recent") return update()
      controller?.abort()
      ++version
      if (searchTimer) clearTimeout(searchTimer)
      remote = []
      cursors = {}
      loading = true
      update()
      searchTimer = setTimeout(() => void search(), 250)
    })
    dialog.box.once("destroyed", () => {
      ++version
      if (searchTimer) clearTimeout(searchTimer)
      controller?.abort()
    })
    // Only results scroll; typing stays in the fixed search field throughout browsing.
    dialog.form.onMouseDown = (event) => event.preventDefault()
    dialog.form.content.onMouse = (event) => {
      if (event.type !== "scroll" || !event.scroll || !["up", "down"].includes(event.scroll.direction)) return
      event.preventDefault()
      event.stopPropagation()
      choose(selected + (event.scroll.direction === "up" ? -3 : 3))
    }
    dialog.form.content.on("resize", reveal)
    dialog.form.viewport.on("resize", reveal)
    dialog.key = (key) => {
      if (matchesKey(key, "f2")) {
        changeScope(scope === "recent" ? "all" : scope === "all" ? "archived" : "recent")
        return true
      }
      if (scope !== "recent" && (matchesKey(key, "f3") || matchesKey(key, "f3", { shift: true }))) {
        if (!loading) {
          const cursor = key.shift ? cursors.previous : cursors.next
          if (failure || cursor) void search(failure ? undefined : (cursor ?? undefined))
        }
        return true
      }
      if (matchesKey(key, "o", { ctrl: true })) {
        const id = query.value.trim()
        dialogs.close(false)
        openByID(id.startsWith("ses_") ? id : "")
        return true
      }
      if (matchesKey(key, "n", { ctrl: true })) {
        create()
        return true
      }
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        choose(selected + (key.name === "up" ? -1 : 1))
        return true
      }
      if (matchesKey(key, "home", { ctrl: true }) || matchesKey(key, "end", { ctrl: true })) {
        choose(key.name === "home" ? 0 : matches.length - 1)
        return true
      }
      if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
        choose(selected + (key.name === "pageup" ? -1 : 1) * Math.max(1, dialog.form.viewport.height - 1))
        return true
      }
      if (!matchesKey(key, "enter")) return false
      open()
      return true
    }
    changeScope(initialScope)
    query.focus()
  }

  function commands(actions: { name: string; description: string; run: () => void }[]) {
    const dialog = dialogs.open("Commands", false, 17)
    if (!dialog) return
    const query = dialogs.input(dialog, "Find a command")
    const choices = actions.map((action) => ({
      ...action,
      title: action.name.toLowerCase(),
      name: `${action.name}  · ${action.description}`,
    }))
    let matches = choices
    const select = new SelectRenderable(renderer, {
      height: 6,
      options: choices,
      showDescription: false,
      showScrollIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedTextColor: color.accent,
      selectedBackgroundColor: color.selected,
    })
    dialog.form.add(select)
    dialogs.track(dialog, select)
    dialog.error.content = "Type to search · ↑/↓ choose · Enter open · Esc close"
    query.on("input", () => {
      const text = query.value.toLowerCase()
      // Actions named by the query come before those that only mention it in their description.
      const named = choices.filter((action) => action.title.includes(text))
      const selected = named.includes(matches[select.getSelectedIndex()]!)
        ? matches[select.getSelectedIndex()]
        : undefined
      matches = [
        ...named,
        ...choices.filter((action) => !named.includes(action) && action.name.toLowerCase().includes(text)),
      ]
      select.options = matches
      select.setSelectedIndex(Math.max(0, selected ? matches.indexOf(selected) : 0))
      dialog.error.content = matches.length ? "↑/↓ choose · Enter open · Esc close" : "No matching commands · Esc close"
    })
    const open = () => {
      const action = matches[select.getSelectedIndex()]
      if (!action) return
      dialogs.close(false)
      action.run()
    }
    dialog.key = (key) => {
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        if (key.name === "up") select.moveUp()
        if (key.name === "down") select.moveDown()
        dialogs.reveal(dialog, select)
        return true
      }
      if (!matchesKey(key, "enter")) return false
      open()
      return true
    }
    select.on("itemSelected", open)
    query.focus()
  }

  function workingFolders() {
    if (!dialogs.navigate()) return
    const dialog = dialogs.open("Working folders", false, 28)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content:
          "Open folders are shared with the GUI. Closing only hides a folder; it does not delete sessions or stop work.",
        fg: color.muted,
      }),
    )
    let directories = state.snapshot?.workingFolders ?? []
    const list = new SelectRenderable(renderer, {
      height: 4,
      options: directories.map((directory) => ({ name: label(directory, 512), description: "" })),
      showDescription: false,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.form.add(list)
    dialogs.track(dialog, list)
    const directory = dialogs.input(
      dialog,
      "Directory on the server",
      state.workingDirectory ?? directories[0] ?? state.snapshot?.location.directory ?? "",
    )
    let replacing = false
    list.on("selectionChanged", (index: number) => {
      if (!replacing && directories[index]) directory.value = directories[index]!
    })
    let closing = false
    const hint = () => {
      dialog.error.height = 3
      dialog.error.content = `Ctrl+S ${closing ? "Close folder in both clients" : "Open folder in both clients"}\nCtrl+R ${closing ? "Open" : "Close"} mode · Tab switch field\nEsc cancel`
      dialog.error.fg = closing ? color.warning : color.muted
    }
    hint()
    dialog.key = (key) => {
      if (matchesKey(key, "enter")) return true
      if (!matchesKey(key, "r", { ctrl: true })) return false
      closing = !closing
      hint()
      return true
    }
    dialog.submit = async () => {
      const target = directory.value.trim()
      const result = await (closing ? connection.folders.close(target) : connection.folders.open(target))
      if (state.closed) return
      if (state.snapshot) state.snapshot.workingFolders = result
      if (!closing) state.workingDirectory = target
      else if (state.workingDirectory === target) state.workingDirectory = undefined
    }
    void connection.folders
      .read()
      .then((result) => {
        if (state.closed || state.modal !== dialog || dialog.busy) return
        directories = result ?? []
        replacing = true
        list.options = directories.map((value) => ({ name: label(value, 512), description: "" }))
        replacing = false
      })
      .catch((error) => {
        if (state.modal === dialog && !dialog.busy)
          dialog.error.content = `${errorText(error)}\nCtrl+S retries the chosen operation · Esc close`
      })
    directory.focus()
  }

  function information(address: string) {
    const dialog = dialogs.open("Details", false, 26)
    if (!dialog) return
    const snapshot = state.snapshot
    const session = state.tab === "sessions" ? snapshot?.sessions.find((item) => item.id === state.selected) : undefined
    const result = state.detail?.sessionID === session?.id ? state.detail : undefined
    const tasks = new Map(
      [...(result?.tasks.data ?? []), ...(result?.tasks.active ?? [])].map((task) => [task.id, task]),
    )
    const sessionMeta: string[] = []
    if (session) {
      const modelStr = session.model
        ? `${session.model.providerID}/${session.model.id}${session.model.variant ? ` (${session.model.variant})` : ""}`
        : "server default"
      sessionMeta.push(
        label(session.title || "Untitled session", 200),
        `Session ID: ${session.id}`,
        ...(session.parentID ? [`Parent ID: ${session.parentID}`] : []),
        `Directory: ${session.location.directory}`,
        `Agent: ${session.agent ?? "server default"}`,
        `Model: ${modelStr}`,
      )
      if (session.time) {
        sessionMeta.push(
          `Created: ${new Date(session.time.created).toLocaleString()}` +
            (session.time.updated ? ` · Updated: ${new Date(session.time.updated).toLocaleString()}` : ""),
        )
      }
      if (session.tokens) {
        const t = session.tokens
        const tokenParts = [`in: ${t.input.toLocaleString()}`, `out: ${t.output.toLocaleString()}`]
        if (t.reasoning) tokenParts.push(`reasoning: ${t.reasoning.toLocaleString()}`)
        if (t.cache?.read || t.cache?.write)
          tokenParts.push(`cache: ${t.cache.read.toLocaleString()}r/${t.cache.write.toLocaleString()}w`)
        sessionMeta.push(
          `Tokens: ${tokenParts.join(" · ")}${session.cost ? ` · Cost: $${session.cost.toFixed(4)}` : ""}`,
        )
      }
    }
    const metadata = sessionMeta.length ? display(sessionMeta.join("\n"), 6000) : ""
    dialog.form.add(
      new TextRenderable(renderer, {
        content: [
          metadata,
          result
            ? `${result.permissions.length} permissions · ${result.questions.length} questions · ${result.pending.length} queued inputs`
            : "",
          tasks.size
            ? display(
                `DELEGATED TASKS\n${[...tasks.values()].map((task) => `[${task.status}] ${display(task.description, 500)}\n${task.agent} · ${task.childSessionID}${task.error ? `\n${display(task.error, 1000)}` : ""}`).join("\n")}`,
                8000,
              )
            : "",
          `SERVER\n${label(address, 1000)}\n${state.connected ? "Connected" : state.connectionError || "Connecting…"}`,
          snapshot
            ? `${label(snapshot.location.directory, 4096)}\nUpdated ${new Date(snapshot.updated).toLocaleString()}${state.connected ? "" : " (stale)"}\n${Object.keys(snapshot.active).length} running agents\n${snapshot.inventoryErrors.terminals ? `Terminal inventory unavailable: ${snapshot.inventoryErrors.terminals}` : snapshot.terminalsAvailable ? `${snapshot.terminals.length} managed terminals` : "Terminal inventory unavailable on this server version"}${snapshot.inventoryErrors.automations ? `\nAutomations unavailable: ${snapshot.inventoryErrors.automations}` : ""}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        fg: color.text,
        wrapMode: "word",
      }),
    )
    dialog.error.content = "Page Up / Down scroll · Esc close"
    dialog.form.focus()
  }

  function help() {
    const dialog = dialogs.open("Keyboard shortcuts", false, 28)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content: [
          "ESSENTIALS\nEnter opens the primary action / sends from editor\nn new session · f reply · Up recalls in an empty editor\nShift+Enter / Alt+Enter adds a line · Ctrl+S also sends\nEsc close / keep draft · F4 discard local draft\n/ commands in conversation/editor · Ctrl+P all actions\nCtrl+C cancels a form; repeat to quit with drafts\nq quits dashboard; repeat if drafts are saved",
          "SESSION VIEWS\nd Changes: uncommitted, branch, or last turn (m switches) · @ mentions a file\ne Files: browse and read · Enter opens a folder · ← up · @ mentions\nT the session's shared terminal (the agent uses it too)\nt Tasks and to-dos · u queued messages: Enter send now, Ctrl+E edit\nw swarm room: lanes, entries, Tab to post · H harness · i details\n/tools the agent's tools and MCP servers · /trace the event log\nThe action row shows the context window: Context 45% · 90k/200k",
          "TERMINALS AND AUTOMATIONS\n2 Terminals: Enter attaches full-screen; Ctrl+] detaches\n  a new terminal · R rename · d close\n3 Automations: Enter manages (run now, pause, edit, runs, delete)\n  a new automation (every 30m, every 1d, or cron) · E edit · d delete",
          "SETTINGS AND INTEL\n, Settings: providers (connect, disconnect, remove), usage and limits,\n  extensions (Enter on/off · s secret · c setting · o sign in),\n  memories (a add · E edit · Ctrl+D delete), agents' default models,\n  permission checks and saved rules, servers, appearance\nI Intel: advisories, known-exploited CVEs, news · m list · f feeds · p poll\nCtrl+P Stop all agents interrupts every session on the server",
          "SERVERS AND HARNESS\ns or click the server name opens the server picker\nThis computer: the running TurenOS app first, then this host's\n  quick-connect or persistent server, or a private forge serve\nPicker: Enter connect · a add URL or user@host · d remove · r rescan\nSSH servers need key or agent login; the TUI opens its own tunnel\nServer passwords are asked once and kept only until you quit\nH or /harness: the session's harness tools, guidance, and\n  reviewer proposals; every change confirms with Ctrl+S",
          "FILES AND SHELL\n@ searches the server's files; Up/Down choose\nTab or Enter completes · Esc closes the list\nA folder keeps searching; a file ends the mention\n@path#12 or @path#12-40 attaches only those lines\nThe server reads mentioned files; this client does not\n! at the start of a message runs a server shell command\nShell output arrives as a transcript message",
          "DASHBOARD (no form or search open)\nCtrl+K switch session · Alt+Left/Right hop\n/ commands in conversation; find/filter in sidebar\nCtrl+X subagent browser · t Tasks\n1 Sessions · 2 Terminals · 3 Automations\nUp/Down select · Enter focus conversation, then reply\nTab / Shift+Tab switch panes · b / Ctrl+B sidebar\nPgUp/PgDn scroll a page · r refresh\nh History / Recent · [ older / ] newer history page\ni session and connection details\nCtrl+Y / right-click copies selected text\nF6 toggles terminal native selection/right-click menu\nIn tmux, Ctrl+B twice sends the sidebar shortcut.",
          "EDITING AND DRAFTS\nCtrl+D delete forward · Ctrl+K delete to line end\nCtrl+A line start · Alt+Left/Right word motion\nF2 or /editor composes the draft in $EDITOR\nEsc first, then Ctrl+K or Alt+Left/Right to switch\nCtrl+N new session also works in drafts and switcher\nTab / Shift+Tab next / previous field\nTab or click Settings reveals launch settings\nReply: Ctrl+T Steer/Queue before sending\nReply: PgUp/PgDn reads the conversation\nAttempted launch: Ctrl+O inspect session\nDrafts last until quit; discard does not stop server work.",
          "PICKERS AND MODELS\nUp/Down choose · Enter select · Esc back\nSession picker: type anytime; Tab stays in search\nF2 Recent / All sessions / Archived\nServer title search: F3 older · Shift+F3 newer\nPgUp/PgDn or wheel browse · Click a result to open\nCtrl+O open older session by ID\nt Tasks · Ctrl+P rename, archive/restore, delete, or open parent\nm session model · Ctrl+L model in New session\nNew session settings (Tab): folder, agent, model, new git worktree\n/agent chooses agent · /compact confirms summarization\nModel picker: F2 provider setup · Ctrl+R refresh\nProvider setup: Enter continue/save · Ctrl+U clear key\nProvider credentials and configuration are server-global.",
          "REQUESTS\nUndo/Redo: Ctrl+D shows the staged patch before confirming\np permission · o question · x interrupt\nPermission starts on Reject; choose Allow once or Allow always,\n  then Ctrl+S to send (always saves the server's rule)\nQuestions: arrows choose · Space toggles multiple\nEnter selects/continues · Left/Right changes question\nReview answers, then Enter / Ctrl+S sends\nCustom answer: Enter saves · Ctrl+B back to choices\nCtrl+R opens rejection · Ctrl+S confirms\nInterrupt: type stop · Ctrl+S confirm\nEsc closes without responding; PgUp/PgDn scrolls forms",
        ].join("\n\n"),
        fg: color.text,
        wrapMode: "word",
      }),
    )
    dialog.error.content = "PgUp/PgDn scroll · Esc close"
    dialog.form.focus()
  }

  return { switcher, workingFolders, openByID, commands, information, help }
}
