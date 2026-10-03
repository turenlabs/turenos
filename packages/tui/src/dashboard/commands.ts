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
    { name: "stop", description: "Confirm interruption", run: c.requests.interrupt },
    { name: "kill", description: "Interrupt session and cancel its tasks", run: c.requests.kill },
    { name: "stop-all", description: "Stop every running agent on this server", run: c.requests.stopAll },
    { name: "commands", description: "All TUI actions", run: () => openCommands(d) },
  ]
}

/** Ctrl+P: every dashboard action with its key. */
export function openCommands(d: DashboardContext) {
  d.c.menus.commands([
    ...sessionCommands(d),
    ...modelCommands(d),
    ...panelCommands(d),
    ...terminalCommands(d),
    ...viewCommands(d),
  ])
}

function sessionCommands(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "Switch session", description: "Ctrl+K", run: c.menus.switcher },
    ...(d.options.servers ? [{ name: "Switch server", description: "s", run: () => openServers(d) }] : []),
    { name: "Browse all sessions", description: "Server title search", run: () => c.menus.switcher("all") },
    {
      name: "Working folders",
      description: "Open or close folders shared with the GUI",
      run: () => c.menus.workingFolders(),
    },
    { name: "Browse archived sessions", description: "Restore older work", run: () => c.menus.switcher("archived") },
    { name: "Open session by ID", description: "Includes older sessions", run: c.menus.openByID },
    { name: "Next session", description: "Alt+Right", run: () => hop(d, 1) },
    { name: "Previous session", description: "Alt+Left", run: () => hop(d, -1) },
    { name: "New session", description: "n", run: c.launch.open },
    { name: "Rename session", description: "Change the selected title", run: c.sessions.rename },
    { name: "Archive / restore session", description: "Hide or restore history", run: c.sessions.archive },
    { name: "Delete session", description: "Permanently, with its subagents", run: c.sessions.remove },
    { name: "Tasks and subagents", description: "Ctrl+X / t", run: c.sessions.tasks },
    { name: "Go to parent session", description: "Open parent", run: c.sessions.parent },
  ]
}

function modelCommands(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "Choose model for this session", description: "m", run: c.models.open },
    { name: "Choose model effort / variant", description: "/effort", run: c.variants.open },
    { name: "Session goal", description: "/goal", run: c.goals.open },
    { name: "Session harness", description: "H / /harness", run: c.harness.open },
    { name: "Choose agent for this session", description: "/agent", run: c.controls.agent },
    { name: "Compact session context", description: "/compact", run: c.controls.compact },
    { name: "Undo conversation turn", description: "/undo", run: c.rewind.undo },
    { name: "Redo conversation turn", description: "/redo", run: c.rewind.redo },
    { name: "Connect provider / add custom model", description: "API key or OAuth", run: c.models.connect },
    { name: "Sessions", description: "1", run: () => changeTab(d, "sessions") },
    { name: "Terminal processes", description: "2", run: () => changeTab(d, "terminals") },
    { name: "Automations", description: "3", run: () => changeTab(d, "automations") },
    { name: "Send follow-up", description: "f", run: c.requests.followup },
    { name: "Queued messages", description: "u · send now, edit, or discard", run: c.queue.open },
  ]
}

function panelCommands(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "Review changes", description: "d · uncommitted, branch, last turn", run: c.changes.open },
    { name: "Browse files", description: "e · read files, @ mention in reply", run: c.files.open },
    { name: "Open session terminal", description: "T · shared with the agent", run: () => void c.terminals.shared() },
    { name: "Swarm room", description: "w · subagent lanes and messages", run: c.room.open },
    { name: "New automation", description: "a in Automations", run: c.automations.create },
    {
      name: "Manage automation",
      description: "Enter in Automations · run, pause, edit, runs",
      run: c.automations.manage,
    },
    { name: "Settings", description: ", · providers, usage, extensions, memories", run: c.settings.open },
    { name: "Extensions", description: "Skills, MCP servers, data sources", run: () => c.extensions.open() },
    { name: "Memories", description: "Wings, rooms, and notes agents recall", run: () => void c.memories.open() },
    { name: "Intel", description: "I · advisories, KEV, security news", run: c.intel.open },
    {
      name: "Session tools",
      description: "/tools · built-in, MCP, and excluded tools",
      run: () => void c.inspect.tools(),
    },
    { name: "Session trace", description: "/trace · the session's event log", run: c.inspect.trace },
  ]
}

function terminalCommands(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "New terminal", description: "a in Terminals", run: c.terminals.create },
    { name: "Attach to terminal", description: "Enter in Terminals · Ctrl+] detaches", run: c.terminals.open },
    { name: "Rename terminal", description: "R in Terminals", run: c.terminals.rename },
    { name: "Close terminal", description: "d in Terminals", run: c.terminals.close },
    { name: "Review permission", description: "p", run: c.requests.permission },
    { name: "Answer question", description: "o", run: c.requests.question },
    { name: "Reject question", description: "Confirm without answering", run: () => c.requests.question(true) },
    { name: "Interrupt session", description: "x", run: c.requests.interrupt },
    { name: "Kill session", description: "Interrupt and cancel its tasks", run: c.requests.kill },
    { name: "Stop all agents", description: "Kill switch for this server", run: c.requests.stopAll },
  ]
}

function viewCommands(d: DashboardContext): Command[] {
  const c = d.c
  return [
    { name: "Search items", description: "/", run: () => filter(d) },
    { name: "Refresh", description: "r", run: () => void d.refresh() },
    { name: "Keyboard help", description: "?", run: c.menus.help },
    { name: "Copy selected text", description: "Ctrl+Y / right-click", run: c.copy.copySelection },
    { name: "Toggle terminal mouse selection", description: "F6 / native right-click menu", run: c.copy.toggleMouse },
    { name: "Session history / live transcript", description: "h", run: c.conversation.toggleHistory },
    {
      name: d.state.rawResponses ? "Show formatted responses" : "Show raw responses",
      description: "Tool results and agent updates",
      run: () => toggleRaw(d),
    },
    { name: "Older history page", description: "[ in History", run: () => c.conversation.page("next") },
    { name: "Newer history page", description: "] in History", run: () => c.conversation.page("previous") },
    { name: "Session and connection details", description: "i", run: () => c.menus.information(d.serverAddress) },
    { name: "Toggle sidebar", description: "b / Ctrl+B", run: () => toggleSidebar(d) },
    {
      name: "Toggle reduced motion",
      description: d.state.reducedMotion ? "Animation off" : "Animation on",
      run: () => toggleMotion(d),
    },
    { name: "Quit dashboard", description: "q / Ctrl+C", run: () => quit(d) },
  ]
}
