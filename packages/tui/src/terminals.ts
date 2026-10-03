import { TextRenderable, type CliRenderer } from "@opentui/core"
import { attachTerminal, type AttachTarget } from "./attach"
import type { Dialogs } from "./dialogs"
import { identifier, object } from "./response-validation"
import { errorText, type Connection, type Snapshot } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Terminal = Snapshot["terminals"][number]

/**
 * Server terminals, as in the desktop's terminal panel: attach full-screen (Ctrl+] detaches and
 * leaves the process running), open new ones, rename or close them, and join a session's shared
 * terminal that the agent's terminal tool also uses.
 */
export function createTerminals(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  refresh: () => Promise<void>,
) {
  function selected() {
    const terminal =
      state.tab === "terminals" ? state.snapshot?.terminals.find((item) => item.id === state.selected) : undefined
    if (!terminal) say("Select a terminal first.")
    return terminal
  }

  function target(terminal: Terminal): AttachTarget {
    return {
      id: terminal.id,
      title: terminal.title,
      directory: terminal.location.directory,
      workspace: terminal.location.workspaceID,
    }
  }

  /** PTYs are location-scoped: every call names the folder and workspace the PTY was opened in. */
  function where(pty: AttachTarget) {
    return { directory: pty.directory, workspace: pty.workspace }
  }

  /** Hands the whole terminal to the PTY until it detaches or exits, then redraws the dashboard. */
  async function attach(pty: AttachTarget) {
    if (!state.connected) return say("Reconnect before attaching to a terminal.", true)
    if (!dialogs.navigate()) return
    renderer.suspend()
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdout.write(`\x1b[2J\x1b[H\x1b[2m${label(pty.title, 80)} on the server · Ctrl+] detaches\x1b[0m\r\n`)
    const result = await attachTerminal({
      url: new URL(connection.address),
      api: connection.api,
      resize: (size) => connection.client.ptys.update({ ptyID: pty.id, location: where(pty), size }),
      target: pty,
      stdin: process.stdin,
      stdout: process.stdout,
    }).finally(() => {
      process.stdin.pause()
      if (!renderer.isDestroyed) renderer.resume()
    })
    if (state.closed) return
    if (result.reason === "failed") say(`Terminal connection failed: ${result.detail}`, true)
    else
      say(result.reason === "exited" ? "The terminal exited." : "Detached. The terminal keeps running on the server.")
    void refresh()
  }

  function open() {
    const terminal = selected()
    if (!terminal) return
    if (terminal.status === "exited")
      return say(
        `This terminal exited${terminal.exitCode === undefined ? "" : ` (code ${terminal.exitCode})`}. d closes it.`,
      )
    void attach(target(terminal))
  }

  /** The session's shared terminal, created on first use; the agent sees what you type there. */
  async function shared() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    try {
      const terminal = await connection.client.sessions.createTerminal({ sessionID: session.id })
      identifier(terminal.ptyID, "pty_")
      await attach({
        id: terminal.ptyID,
        title: `Shared terminal · ${session.title || session.id}`,
        directory: session.location.directory,
        workspace: terminal.workspaceID ?? session.location.workspaceID,
      })
    } catch (error) {
      say(`Session terminal unavailable: ${errorText(error)}`, true)
    }
  }

  function create() {
    const dialog = dialogs.open("New terminal", false, 20)
    if (!dialog) return
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    const title = dialogs.input(dialog, "Title (optional)")
    const folder = dialogs.input(
      dialog,
      "Folder on the server",
      session?.location.directory ?? state.snapshot?.location.directory ?? "",
    )
    dialog.form.add(
      new TextRenderable(renderer, { content: "Runs your default shell. Ctrl+] detaches.", fg: color.muted }),
    )
    let created: AttachTarget | undefined
    dialog.submit = async () => {
      if (!state.connected) throw new Error("Reconnect before opening a terminal.")
      created ??= await connection.client.ptys
        .create({ location: { directory: folder.value }, title: title.value.trim() || undefined })
        .then((response) => {
          const pty = object(response.data)
          return {
            id: identifier(pty.id, "pty_"),
            title: typeof pty.title === "string" ? pty.title : "Terminal",
            directory: response.location.directory,
            workspace: response.location.workspaceID,
          }
        })
    }
    dialog.afterSubmit = () => {
      if (created) void attach(created)
    }
    dialog.error.content = "Ctrl+S Open and attach · Esc cancel"
    title.focus()
  }

  function rename() {
    const terminal = selected()
    if (!terminal) return
    const dialog = dialogs.open("Rename terminal", false, 14)
    if (!dialog) return
    const title = dialogs.input(dialog, "Title", terminal.title)
    dialog.submit = async () => {
      if (!title.value.trim()) throw new Error("Enter a title.")
      await connection.client.ptys.update({
        ptyID: terminal.id,
        location: where(target(terminal)),
        title: title.value.trim(),
      })
      say("Terminal renamed.")
    }
    dialog.error.content = "Ctrl+S Save · Esc cancel"
    title.focus()
  }

  function close() {
    const terminal = selected()
    if (!terminal) return
    const dialog = dialogs.open("Close terminal", false, 14)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `${label(terminal.title, 100)} · PID ${terminal.pid}\n${terminal.status === "running" ? "Ends the process and its output." : "Removes the exited terminal and its output."}`,
        fg: terminal.status === "running" ? color.warning : color.text,
        wrapMode: "word",
      }),
    )
    dialog.submit = async () => {
      await connection.client.ptys.remove({ ptyID: terminal.id, location: where(target(terminal)) })
      say("Terminal closed.")
    }
    dialog.error.content = "Ctrl+S Close terminal · Esc cancel"
    dialog.form.focus()
  }

  return { open, shared, create, rename, close }
}
