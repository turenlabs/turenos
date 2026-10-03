import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { openSection, type Choice, type Picker } from "../picker"
import type { Connection } from "../server"
import type { DashboardState } from "../state"
import { color } from "../theme"

export type SettingsHooks = {
  connectProvider: () => void
  extensions: (back: () => void) => void
  memories: (back: () => void) => void
  servers?: () => void
  appearance: () => Choice[]
}

/** What every settings section shares; `open` returns to the Settings menu. */
export type SettingsContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  hooks: SettingsHooks
  open: () => void
}

export function directory(ctx: SettingsContext) {
  return (
    ctx.state.snapshot?.sessions.find((item) => item.id === ctx.state.selected)?.location.directory ??
    ctx.state.snapshot?.location.directory ??
    "/"
  )
}

/** Opens a section that loads before it can list its choices. */
export function section<T>(
  ctx: SettingsContext,
  title: string,
  work: () => Promise<T>,
  fill: (value: T, picker: Picker) => void,
) {
  return openSection(ctx.renderer, ctx.dialogs, ctx.state, { title, back: ctx.open }, work, fill)
}

export function confirm(ctx: SettingsContext, title: string, text: string, action: () => Promise<void>) {
  const dialog = ctx.dialogs.open(title, false, 14)
  if (!dialog) return
  dialog.form.add(new TextRenderable(ctx.renderer, { content: text, fg: color.warning, wrapMode: "word" }))
  dialog.submit = action
  dialog.error.content = "Ctrl+S confirm · Esc cancel"
  dialog.form.focus()
}
