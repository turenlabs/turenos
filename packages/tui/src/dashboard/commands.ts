import { changeTab, filter, hop } from "./navigation"
import { openServers, quit } from "./lifecycle"
import { toggleMotion, toggleRaw, toggleSidebar } from "./toggles"
import type { DashboardContext } from "./context"

type Command = { name: string; description: string; run: () => void }

/** The `/` commands offered in the editor and in the keyboard-driven command list. */
export function slashCommands(d: DashboardContext): Command[] {
  return [...sessionSlash(d), ...workflowSlash(d), ...configSlash(d), ...historySlash(d), ...serverSlash(d)]
}

function sessionSlash(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "help", description: "Keyboard help", run: c.menus.help },
    { name: "new", description: "New session", run: c.launch.open },
    { name: "sessions", description: "Find a session", run: c.menus.switcher },
    { name: "model", description: "Choose a model", run: c.models.open },
    { name: "editor", description: "Compose the message in $EDITOR", run: () => void c.dialogs.compose() },
    { name: "effort", description: "Choose model effort / variant", run: c.variants.open },
    { name: "variant", description: "Choose model effort / variant", run: c.variants.open },
    { name: "agent", description: "Choose session agent", run: c.controls.agent },
  ]
}

function workflowSlash(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "goal", description: "Inspect and control the session goal", run: c.goals.open },
    { name: "harness", description: "Session harness: tools, guidance, reviewer proposals", run: c.harness.open },
    { name: "queued", description: "Send now, edit, or discard queued messages", run: c.queue.open },
    { name: "changes", description: "Review uncommitted, branch, or last-turn changes", run: c.changes.open },
    { name: "files", description: "Browse and read the session's files", run: c.files.open },
    { name: "terminal", description: "Open the session's shared terminal", run: () => void c.terminals.shared() },
    { name: "room", description: "Swarm room: lanes, entries, post as a human", run: c.room.open },
  ]
}

function configSlash(d: DashboardContext): Command[] {
  const c = d.c
  return [
    {
      name: "settings",
      description: "Providers, usage, extensions, memories, agents, permissions",
      run: c.settings.open,
    },
    { name: "extensions", description: "Skills, MCP servers, and data sources", run: () => c.extensions.open() },
    { name: "memories", description: "What agents remember across sessions", run: () => void c.memories.open() },
    { name: "intel", description: "Advisories, known-exploited CVEs, and security news", run: c.intel.open },
    {
      name: "tools",
      description: "Tools and MCP servers this session's agent can use",
      run: () => void c.inspect.tools(),
    },
    { name: "trace", description: "Page through this session's event log", run: c.inspect.trace },
  ]
}

function historySlash(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "compact", description: "Confirm context summarization", run: c.controls.compact },
    { name: "undo", description: "Stage a reversible conversation rewind", run: c.rewind.undo },
    { name: "rewind", description: "Pick an earlier message to rewind to", run: c.rewind.pick },
    { name: "redo", description: "Restore the next staged turn", run: c.rewind.redo },
    { name: "history", description: "Toggle expanded history", run: c.conversation.toggleHistory },
    { name: "tasks", description: "Tasks and subagents", run: c.sessions.tasks },
    { name: "subagents", description: "Browse delegated tasks", run: c.sessions.tasks },
    { name: "rename", description: "Rename session", run: c.sessions.rename },
    { name: "delete", description: "Delete session and its subagents", run: c.sessions.remove },
  ]
}

function serverSlash(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "info", description: "Session and server details", run: () => c.menus.information(d.serverAddress) },
    { name: "details", description: "Session and server details", run: () => c.menus.information(d.serverAddress) },
    { name: "folders", description: "Manage working folders", run: () => c.menus.workingFolders() },
    ...(d.options.servers
      ? [{ name: "servers", description: "Switch TurenOS server", run: () => openServers(d) }]
      : []),
    { name: "stop", description: "Stop this session and cancel its tasks now", run: c.requests.interrupt },
    { name: "kill", description: "Stop this session and cancel its tasks", run: c.requests.kill },
    { name: "stop-all", description: "Stop every running agent on this server (kill switch)", run: c.requests.stopAll },
    { name: "commands", description: "All TUI actions", run: () => openCommands(d) },
  ]
}

/** A palette row: name, what it does, and the key or slash command that does it without the palette. */
type Entry = { name: string; description: string; key?: string; run: () => void }

/** Ctrl+P: every dashboard action, grouped Session, Conversation, Requests, Panels, Terminals, Team, Settings, View; Team first on its tab. */
export function openCommands(d: DashboardContext) {
  const team = teamEntries(d)
  const groups = [
    sessionEntries(d),
    conversationEntries(d),
    requestEntries(d),
    panelEntries(d),
    terminalEntries(d),
    team,
    settingsEntries(d),
    viewEntries(d),
  ]
  // On the Team tab its own commands lead; the rest keep their order.
  d.c.menus.commands(
    d.state.tab === "team" ? [...team, ...groups.filter((group) => group !== team).flat()] : groups.flat(),
  )
}

function sessionEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Switch session", description: "Jump to a session", key: "Ctrl+K", run: c.menus.switcher },
    { name: "Next session", description: "Hop forward", key: "Alt+Right", run: () => hop(d, 1) },
    { name: "Previous session", description: "Hop back", key: "Alt+Left", run: () => hop(d, -1) },
    { name: "New session", description: "Folder, agent, model", key: "n", run: c.launch.open },
    { name: "Browse all sessions", description: "Server title search", run: () => c.menus.switcher("all") },
    { name: "Browse archived sessions", description: "Restore older work", run: () => c.menus.switcher("archived") },
    { name: "Open session by ID", description: "Includes older sessions", run: c.menus.openByID },
    { name: "Rename session", description: "Change the selected title", run: c.sessions.rename },
    { name: "Archive / restore session", description: "Hide or restore history", run: c.sessions.archive },
    { name: "Delete session", description: "Permanently, with its subagents", run: c.sessions.remove },
    { name: "Tasks and subagents", description: "Delegated work", key: "t", run: c.sessions.tasks },
    ...(hasParent(d) ? [{ name: "Go to parent session", description: "Open the parent", run: c.sessions.parent }] : []),
    ...(d.options.servers
      ? [{ name: "Switch server", description: "Choose a server", key: "s", run: () => openServers(d) }]
      : []),
    { name: "Working folders", description: "Shared with the GUI", run: () => c.menus.workingFolders() },
  ]
}

function hasParent(d: DashboardContext) {
  return !!d.state.snapshot?.sessions.find((session) => session.id === d.state.selected)?.parentID
}

function conversationEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Send follow-up", description: "Reply to the session", key: "f", run: c.requests.followup },
    { name: "Queued messages", description: "Send now, edit, discard", key: "u", run: c.queue.open },
    { name: "Choose model for this session", description: "Model for new turns", key: "m", run: c.models.open },
    { name: "Choose model effort / variant", description: "Reasoning effort", key: "/effort", run: c.variants.open },
    { name: "Choose agent for this session", description: "Switch agent", key: "/agent", run: c.controls.agent },
    { name: "Connect a provider", description: "API key or OAuth", run: c.models.connect },
    { name: "Session goal", description: "Inspect and control", key: "/goal", run: c.goals.open },
    { name: "Session harness", description: "Tools and guidance", key: "H or /harness", run: c.harness.open },
    { name: "Compact session context", description: "Summarize history", key: "/compact", run: c.controls.compact },
    { name: "Undo conversation turn", description: "Stage a rewind", key: "/undo", run: c.rewind.undo },
    { name: "Rewind to an earlier message", description: "Pick a message", key: "/rewind", run: c.rewind.pick },
    { name: "Redo conversation turn", description: "Restore a staged turn", key: "/redo", run: c.rewind.redo },
  ]
}

function requestEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Review permission", description: "Allow or reject", key: "p", run: c.requests.permission },
    { name: "Answer question", description: "Reply to the agent", key: "o", run: c.requests.question },
    { name: "Reject question", description: "Confirm without answering", run: () => c.requests.question(true) },
    {
      name: "Stop session",
      description: "Interrupt the running session and cancel its tasks",
      key: "x or /stop",
      run: c.requests.interrupt,
    },
    {
      name: "Kill session",
      description: "Confirm stopping this session and its tasks, even when idle",
      key: "/kill",
      run: c.requests.kill,
    },
    { name: "Stop all agents", description: "Kill switch for this server", key: "/stop-all", run: c.requests.stopAll },
  ]
}

function panelEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Review changes", description: "Uncommitted, branch, last turn", key: "d", run: c.changes.open },
    { name: "Browse files", description: "Read files, @ mention", key: "e", run: c.files.open },
    {
      name: "Open session terminal",
      description: "Shared with the agent",
      key: "T",
      run: () => void c.terminals.shared(),
    },
    { name: "Swarm room", description: "Subagent lanes and messages", key: "w", run: c.room.open },
    { name: "Session tools", description: "Built-in, MCP, excluded", key: "/tools", run: () => void c.inspect.tools() },
    { name: "Session trace", description: "The event log", key: "/trace", run: c.inspect.trace },
    {
      name: "Session and connection details",
      description: "Session and server",
      key: "i",
      run: () => c.menus.information(d.serverAddress),
    },
  ]
}

function terminalEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Sessions", description: "Show the session list", key: "1", run: () => changeTab(d, "sessions") },
    { name: "Terminal processes", description: "Show terminals", key: "2", run: () => changeTab(d, "terminals") },
    { name: "New terminal", description: "In the Terminals tab", key: "a", run: c.terminals.create },
    { name: "Attach to terminal", description: "Ctrl+] detaches", key: "Enter", run: c.terminals.open },
    { name: "Rename terminal", description: "In the Terminals tab", key: "R", run: c.terminals.rename },
    { name: "Close terminal", description: "In the Terminals tab", key: "d", run: c.terminals.close },
    { name: "Automations", description: "Show automations", key: "3", run: () => changeTab(d, "automations") },
    { name: "New automation", description: "In the Automations tab", key: "a", run: c.automations.create },
    { name: "Manage automation", description: "Run, pause, edit, runs", key: "Enter", run: c.automations.manage },
  ]
}

function teamEntries(d: DashboardContext): Entry[] {
  return [
    { name: "Team", description: "Show Team rooms", key: "4", run: () => changeTab(d, "team") },
    ...d.c.team.actions.map((action) => ({
      name: action.name,
      description: action.description,
      key: action.key,
      run: action.run,
    })),
  ]
}

function settingsEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Settings", description: "Providers, usage, servers", key: ",", run: c.settings.open },
    { name: "Extensions", description: "Skills, MCP, data sources", run: () => c.extensions.open() },
    { name: "Memories", description: "What agents recall", run: () => void c.memories.open() },
    { name: "Intel", description: "Advisories, KEV, news", key: "I", run: c.intel.open },
  ]
}

function viewEntries(d: DashboardContext): Entry[] {
  const c = d.c
  return [
    { name: "Search items", description: "Find or filter the list", key: "/", run: () => filter(d) },
    { name: "Refresh", description: "Reload from the server", key: "r", run: () => void d.refresh() },
    { name: "Keyboard help", description: "All shortcuts", key: "?", run: c.menus.help },
    { name: "Copy selected text", description: "Selection to clipboard", key: "Ctrl+Y", run: c.copy.copySelection },
    { name: "Toggle terminal mouse selection", description: "Native selection", key: "F6", run: c.copy.toggleMouse },
    {
      name: "Session history / live transcript",
      description: "Switch the view",
      key: "h",
      run: c.conversation.toggleHistory,
    },
    {
      name: d.state.rawResponses ? "Show formatted responses" : "Show raw responses",
      description: "Tool results and updates",
      run: () => toggleRaw(d),
    },
    {
      name: d.state.expandToolOutput ? "Collapse tool output" : "Expand tool output",
      description: "Long tool results",
      key: "Ctrl+O",
      run: c.conversation.toggleToolOutput,
    },
    { name: "Older history page", description: "In History", key: "[", run: () => c.conversation.page("next") },
    { name: "Newer history page", description: "In History", key: "]", run: () => c.conversation.page("previous") },
    { name: "Toggle sidebar", description: "Show or hide the list", key: "b or Ctrl+B", run: () => toggleSidebar(d) },
    { name: "Hide screen", description: "An anvil until a click or Esc", key: "Ctrl+H", run: c.screensaver.show },
    {
      name: "Toggle reduced motion",
      description: d.state.reducedMotion ? "Now on, animation off" : "Now off, animation on",
      run: () => toggleMotion(d),
    },
    { name: "Quit dashboard", description: "Repeat if work is unsent", key: "q or Ctrl+C", run: () => quit(d) },
  ]
}
