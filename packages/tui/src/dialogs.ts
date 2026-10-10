import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core"
import type { DashboardState, Field, ModalState } from "./state"
import type { DashboardLayout } from "./layout"
import type { DialogContext, DialogHooks } from "./dialogs/context"
import { compose } from "./dialogs/compose"
import { input, prompt, reveal, track } from "./dialogs/fields"
import { keypress } from "./dialogs/keypress"
import { close, guardMouseFocus, navigate } from "./dialogs/lifecycle"
import { open } from "./dialogs/open"
import { paste } from "./dialogs/paste"
import { submit } from "./dialogs/submit"

export function createDialogs(renderer: CliRenderer, state: DashboardState, ui: DashboardLayout, hooks: DialogHooks) {
  const ctx: DialogContext = { renderer, state, ui, hooks }
  guardMouseFocus(ctx)
  return {
    open: (title: string, inline = false, height = 24, docked = false, sidebar = false, keepNotice = false) =>
      open(ctx, title, inline, height, docked, sidebar, keepNotice),
    close: (save = true) => close(ctx, save),
    navigate: () => navigate(ctx),
    input: (dialog: ModalState, label: string, value = "", placeholder = "") =>
      input(ctx, dialog, label, value, placeholder),
    prompt: (dialog: ModalState, label: string, value = "", cursor = value.length, bare = false) =>
      prompt(ctx, dialog, label, value, cursor, bare),
    track: (dialog: ModalState, field: Field) => track(ctx, dialog, field),
    reveal,
    submit: () => submit(ctx),
    compose: () => compose(ctx),
    keypress: (key: KeyEvent) => keypress(ctx, key),
    paste: (event: PasteEvent) => paste(ctx, event),
    resize: ui.resize,
  }
}

export type Dialogs = ReturnType<typeof createDialogs>
