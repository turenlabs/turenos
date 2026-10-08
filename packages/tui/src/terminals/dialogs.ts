import { TextRenderable } from "@opentui/core"
import type { AttachTarget } from "../attach"
import { identifier, object } from "../response-validation"
import { label } from "../state"
import { color } from "../theme"
import { attach } from "./attach"
import { selected, target, where, type Context } from "./context"

export function create(ctx: Context) {
  const dialog = ctx.dialogs.open("New terminal", false, 20)
  if (!dialog) return
  const session = ctx.state.snapshot?.sessions.find((item) => item.id === ctx.state.selected)
  const title = ctx.dialogs.input(dialog, "Title (optional; blank names it after the folder)")
  const folder = ctx.dialogs.input(
    dialog,
    "Folder on the server",
    session?.location.directory ?? ctx.state.snapshot?.location.directory ?? "",
  )
  dialog.form.add(
    new TextRenderable(ctx.renderer, { content: "Runs your default shell. Ctrl+] detaches.", fg: color.muted }),
  )
  let created: AttachTarget | undefined
  dialog.submit = async () => {
    if (!ctx.state.connected) throw new Error("Reconnect before opening a terminal.")
    created ??= await ctx.connection.client.ptys
      .create({
        location: { directory: folder.value },
        title: title.value.trim() || `Shell in ${folder.value.replace(/\/+$/, "").split("/").at(-1) || "/"}`,
      })
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
    if (!created) return
    if (ctx.state.tab === "terminals") ctx.state.selected = created.id
    void attach(ctx, created)
  }
  dialog.error.content = "Tab next field · Ctrl+S Open and attach · Esc close"
  title.focus()
}

export function rename(ctx: Context) {
  const terminal = selected(ctx)
  if (!terminal) return
  const dialog = ctx.dialogs.open("Rename terminal", false, 14)
  if (!dialog) return
  const title = ctx.dialogs.input(dialog, "Title", label(terminal.title, 200))
  dialog.submit = async () => {
    if (!title.value.trim()) throw new Error("Enter a title.")
    await ctx.connection.client.ptys.update({
      ptyID: terminal.id,
      location: where(target(terminal)),
      title: title.value.trim(),
    })
    ctx.say("Terminal renamed.")
  }
  dialog.error.content = "Ctrl+S Save · Esc close"
  title.focus()
}

export function close(ctx: Context) {
  const terminal = selected(ctx)
  if (!terminal) return
  const dialog = ctx.dialogs.open("Close terminal", false, 14)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${label(terminal.title, 100)} · PID ${terminal.pid}\n${terminal.status === "running" ? "Ends the process and its output." : "Removes the exited terminal and its output."}`,
      fg: terminal.status === "running" ? color.warning : color.text,
      wrapMode: "word",
    }),
  )
  dialog.submit = async () => {
    await ctx.connection.client.ptys.remove({ ptyID: terminal.id, location: where(target(terminal)) })
    ctx.say("Terminal closed.")
  }
  dialog.error.content = "Ctrl+S Close terminal · Esc close"
  dialog.form.focus()
}
