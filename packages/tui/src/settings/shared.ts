import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { openSection, type Choice, type Picker } from "../picker"
import type { Connection } from "../server"
import type { DashboardState } from "../state"
import { color } from "../theme"

export type SettingsHooks = {
  connectProvider: (back: () => void) => void
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
  /** Selected row per picker title, so returning from an action keeps the cursor. */
  memory: Map<string, number>
  /** Providers removed this session; the catalog can keep listing them until the server restarts. */
  removed: Set<string>
  /** What the last action reported; the section it returns to shows it, since the dialog covers the toast. */
  notice: string
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
  return openSection(
    ctx.renderer,
    ctx.dialogs,
    ctx.state,
    { title, back: ctx.open, memory: ctx.memory },
    work,
    (value, picker) => {
      fill(value, picker)
      if (!ctx.notice) return
      picker.text.content = `${ctx.notice}\n${picker.text.plainText}`
      picker.fit()
      ctx.notice = ""
    },
  )
}

/** Ctrl+S runs `action`; Esc and finishing both return through `back`, normally the section that asked. */
export function confirm(
  ctx: SettingsContext,
  title: string,
  text: string,
  action: () => Promise<void>,
  back?: () => void,
) {
  const dialog = ctx.dialogs.open(title, false, 14)
  if (!dialog) return
  dialog.form.add(new TextRenderable(ctx.renderer, { content: text, fg: color.warning, wrapMode: "word" }))
  dialog.submit = action
  dialog.afterSubmit = back
  dialog.back = back
  dialog.error.content = "Ctrl+S confirm · Esc cancel"
  dialog.form.focus()
}
