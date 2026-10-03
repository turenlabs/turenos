import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
  TextAttributes,
  fg,
  t,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core"
import { errorText } from "./server"
import { composeInEditor, editorArgv, MISSING_EDITOR } from "./editor"
import { display } from "./messages"
import { color } from "./theme"
import type { DashboardState, Field, ModalState } from "./state"
import type { DashboardLayout } from "./layout"
import { matchesKey } from "./keys"

export function createDialogs(
  renderer: CliRenderer,
  state: DashboardState,
  ui: DashboardLayout,
  hooks: {
    rememberPosition: () => void
    cancelPosition: () => void
    changed: (reload: boolean) => void
    submitted: () => Promise<void>
    say: (message: string, error?: boolean) => void
    recall?: () => string | undefined
  },
) {
  ui.root.onMouseDown = (event) => {
    if (!state.modal) return
    let target = event.target
    while (target && target !== state.modal.box) target = target.parent
    // Navigation handlers may save/close the form first. Otherwise keep the
    // renderer's automatic mouse focus inside the form, including same-row clicks.
    if (!target) event.preventDefault()
  }

  function close(save = true) {
    if (!state.modal || state.modal.busy) return
    const current = state.modal
    if (save) current.save?.()
    state.modal = undefined
    current.box.destroyRecursively()
    renderer.setCursorPosition(0, 0, false)
    hooks.changed(save)
  }

  // Every navigation entry point uses this policy. Only explicit Escape abandons
  // a request without a saved draft; an in-flight submission cannot be abandoned.
  function navigate() {
    if (!state.modal) return true
    if (state.modal.busy || (!state.modal.save && !state.modal.allowNavigation)) return false
    state.modal.onNavigate?.()
    close()
    return true
  }

  function open(title: string, inline = false, height = 24, docked = false, sidebar = false) {
    if (state.modal) return undefined
    if (inline) hooks.rememberPosition()
    hooks.say("")
    const overlay = new BoxRenderable(renderer, {
      position: docked ? "relative" : "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: docked ? 9 : "100%",
      flexShrink: 0,
      marginTop: docked ? 1 : 0,
      zIndex: 10,
      backgroundColor: color.bg,
      alignItems: "center",
      justifyContent: "center",
      onMouseDown: (event) => {
        const current = state.modal
        current?.fields[current.index]?.focus()
        if (!current) return
        let target = event.target
        while (target && !target.focusable) target = target.parent
        // Native autofocus runs after bubbling; blank form space must not steal field focus.
        if (target === current.form) event.preventDefault()
      },
    })
    if (inline) ui.main.add(overlay)
    if (docked) ui.main.add(overlay, Math.max(0, ui.main.getChildren().indexOf(ui.actions)))
    if (!inline && !docked) (sidebar ? ui.sidebar : ui.root).add(overlay)
    const frame = new BoxRenderable(renderer, {
      width: inline || docked || sidebar ? "100%" : "95%",
      height: inline || docked || sidebar ? "100%" : "95%",
      maxWidth: docked ? undefined : inline ? 88 : 70,
      maxHeight: docked ? undefined : inline ? 32 : height,
      border: docked ? ["left"] : true,
      borderStyle: "rounded",
      borderColor: docked ? color.focus : color.border,
      title: ` ${title} `,
      titleColor: color.text,
      padding: docked ? 0 : 1,
      paddingX: docked ? 2 : 1,
      backgroundColor: color.panel,
      flexDirection: "column",
      gap: docked ? 0 : 1,
    })
    overlay.add(frame)
    const error = new TextRenderable(renderer, {
      content: "Tab next · Shift+Tab back · Ctrl+Enter / Ctrl+S submit · Esc close",
      fg: color.muted,
      height: 2,
      flexShrink: 0,
    })
    const form = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 1,
      contentOptions: { flexDirection: "column", paddingRight: 1 },
    })
    frame.add(form)
    frame.add(error)
    state.modal = {
      box: overlay,
      frame,
      form,
      fields: [],
      index: 0,
      busy: false,
      inline,
      docked,
      sidebar,
      height,
      error,
    }
    ui.sidebarHeading.fg = color.muted
    ui.resize()
    return state.modal
  }

  function input(dialog: ModalState, label: string, value = "", placeholder = "") {
    const caption = new TextRenderable(renderer, { content: label, fg: color.muted })
    dialog.form.add(caption)
    const field = new InputRenderable(renderer, {
      value,
      placeholder,
      maxLength: 4096,
      backgroundColor: color.bg,
      textColor: color.text,
      focusedBackgroundColor: color.selected,
      placeholderColor: color.muted,
      marginBottom: 1,
    })
    dialog.form.add(field)
    caption.onMouseDown = (event) => {
      event.preventDefault()
      field.focus()
    }
    track(dialog, field)
    return field
  }

  function prompt(dialog: ModalState, label: string, value = "", cursor = value.length) {
    const caption = new TextRenderable(renderer, { content: label, fg: color.text, attributes: TextAttributes.BOLD })
    dialog.form.add(caption)
    const field = new TextareaRenderable(renderer, {
      height: 6,
      minHeight: 3,
      backgroundColor: color.bg,
      textColor: color.text,
      focusedBackgroundColor: color.selected,
      wrapMode: "word",
      placeholder: "Type a message… / commands · @ files · ! shell",
      placeholderColor: color.muted,
      marginBottom: 1,
      initialValue: value,
    })
    field.onContentChange = () => {
      if (field.plainText.length <= 32000) return
      field.setText(field.plainText.slice(0, 32000))
      dialog.error.content = "Task is limited to 32,000 characters."
    }
    dialog.form.add(field)
    field.cursorOffset = Math.max(0, Math.min(cursor, value.length))
    dialog.editor = field
    const send = new TextRenderable(renderer, {
      content: "[ Send (Enter) ]",
      height: 1,
      width: 16,
      flexShrink: 0,
      fg: color.bg,
      bg: color.accent,
      attributes: TextAttributes.BOLD,
      onMouseDown: (event) => {
        event.preventDefault()
        if (event.button === 0) void submit()
      },
    })
    dialog.send = send
    dialog.frame.add(send, dialog.frame.getChildren().indexOf(dialog.error))
    caption.onMouseDown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      field.focus()
    }
    track(dialog, field)
    return field
  }

  function track(dialog: ModalState, field: Field) {
    dialog.fields.push(field)
    field.on("focused", () => {
      if (state.modal !== dialog) return
      dialog.index = dialog.fields.indexOf(field)
      reveal(dialog, field)
    })
  }

  function reveal(dialog: ModalState, field: Field) {
    let parent = field.parent
    while (parent && parent !== dialog.form) parent = parent.parent
    if (!parent) return
    const top = field.y - dialog.form.viewport.y
    const bottom = top + field.height - dialog.form.viewport.height
    if (top < 0) dialog.form.scrollBy(top - 1)
    if (bottom > 0) dialog.form.scrollBy(bottom + 1)
  }

  async function submit() {
    const current = state.modal
    if (!current?.submit || current.busy) return
    if (current.beforeSubmit?.()) return
    current.busy = true
    if (current.send) current.send.content = "[ Sending... ]"
    current.error.height = 2
    current.error.content = "Submitting…"
    hooks.changed(false)
    const shield = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 20,
      backgroundColor: "#00000001",
      onMouse: (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
    })
    if (current.docked) ui.root.add(shield)
    if (!current.docked) current.box.add(shield)
    try {
      await current.submit()
      if (state.closed) return
      current.busy = false
      close(false)
      await hooks.submitted()
      current.afterSubmit?.()
    } catch (error) {
      if (state.closed) return
      current.error.height = current.reference ? 6 : 4
      current.error.content = t`${fg(color.muted)(`${current.editor ? "Enter in message / " : ""}Ctrl+S retry · Esc ${current.save ? "keep draft" : "close"}${current.discard ? " · F4 discard" : ""}\n${current.reference ? `Session: ${current.reference}\nCtrl+O inspect this session\n` : ""}`)}${fg(color.error)(`! ${errorText(error)}`)}`
      current.error.fg = color.muted
      current.busy = false
      if (current.send) current.send.content = "[ Send (Enter) ]"
      ui.resize()
      hooks.changed(false)
    } finally {
      if (!shield.isDestroyed) shield.destroyRecursively()
    }
  }

  /**
   * Hand the terminal to the operator's editor and take it back. The renderer
   * owns the screen and raw input, so the child runs with the renderer suspended
   * and the terminal is always reclaimed, including when the editor fails.
   */
  async function compose() {
    const current = state.modal
    const editor = current?.editor
    if (!current || !editor || current.busy) return
    if (current.editorLocked?.()) {
      current.error.content = "The original submission is locked. Retry it, or press F4 to discard the local draft."
      current.error.fg = color.error
      return
    }
    // Resolve the command before taking the terminal: with nothing to launch,
    // suspending and resuming would only flicker the screen.
    if (!editorArgv()) return hooks.say(MISSING_EDITOR, true)
    current.busy = true
    let suspended = false
    try {
      renderer.suspend()
      suspended = true
      // suspend() releases the terminal natively; this is a cheap reassertion so
      // a full-screen editor is never handed a raw-mode stdin.
      process.stdin.setRawMode?.(false)
      const edited = await composeInEditor(editor.plainText)
      if (state.closed || state.modal !== current || editor.isDestroyed) return
      editor.setText(edited)
      editor.cursorOffset = edited.length
      hooks.say(edited ? "Draft updated from your editor. Nothing was sent." : "The editor returned an empty draft.")
    } catch (error) {
      if (state.closed || state.modal !== current) return
      hooks.say(errorText(error), true)
    } finally {
      if (suspended && !renderer.isDestroyed) renderer.resume()
      current.busy = false
      if (!state.closed && !renderer.isDestroyed && state.modal === current && !editor.isDestroyed) {
        editor.focus()
        ui.resize()
      }
    }
  }

  function keypress(key: KeyEvent) {
    const current = state.modal
    if (!current) return false
    // Native bindings do not distinguish Hyper; do not let it fall through as an unmodified key.
    if (current.busy || key.hyper || key.eventType === "release") {
      key.preventDefault()
      return true
    }
    // Gated on a focused prompt editor so the pickers keep their own F2.
    if (matchesKey(key, "f2") && current.editor?.focused) {
      key.preventDefault()
      void compose()
      return true
    }
    if (matchesKey(key, "escape")) {
      key.preventDefault()
      close()
      current.back?.()
      return true
    }
    if (current.editor?.focused && !current.editor.plainText && matchesKey(key, "up")) {
      const previous = hooks.recall?.()
      if (previous) {
        key.preventDefault()
        if (previous.length > 32000)
          hooks.say("Previous prompt is too long for this editor. Copy the needed text from History.")
        else current.editor.setText(display(previous, 32000))
        return true
      }
    }
    if (matchesKey(key, "f4") && current.discard) {
      key.preventDefault()
      current.discard()
      close(false)
      hooks.changed(true)
      hooks.say("Local draft discarded. Server work continues.")
      return true
    }
    if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
      key.preventDefault()
      if (current.key?.(key)) return true
      if (current.docked) hooks.cancelPosition()
      const target = current.docked && current.editor ? ui.detail : current.form
      target.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, target.viewport.height - 1))
      return true
    }
    if (matchesKey(key, "tab") || matchesKey(key, "tab", { shift: true })) {
      key.preventDefault()
      if (!current.fields.length) {
        current.form.focus()
        renderer.setCursorPosition(0, 0, false)
        return true
      }
      current.settings?.()
      current.index = (current.index + (key.shift ? -1 : 1) + current.fields.length) % current.fields.length
      const focusedField = current.fields[current.index]
      focusedField?.focus()
      if (!(focusedField instanceof InputRenderable) && !(focusedField instanceof TextareaRenderable)) {
        renderer.setCursorPosition(0, 0, false)
      }
      if (focusedField) reveal(current, focusedField)
      return true
    }
    if (current.editor?.focused && matchesKey(key, "enter")) {
      key.preventDefault()
      void submit()
      return true
    }
    if (
      current.editor?.focused &&
      (matchesKey(key, "enter", { shift: true }) || matchesKey(key, "enter", { meta: true }))
    ) {
      key.preventDefault()
      current.editor.insertText("\n")
      return true
    }
    if (matchesKey(key, "enter", { ctrl: true }) || matchesKey(key, "s", { ctrl: true })) {
      key.preventDefault()
      void submit()
      return true
    }
    if (current.key?.(key)) key.preventDefault()
    return true
  }

  function paste(event: PasteEvent) {
    if (ui.sizeNotice.visible) return event.preventDefault()
    const current = state.modal
    if (current?.busy) return event.preventDefault()
    const field = current?.fields[current.index]
    if (
      field instanceof TextareaRenderable &&
      (event.bytes.byteLength > 128000 || field.plainText.length + new TextDecoder().decode(event.bytes).length > 32000)
    ) {
      event.preventDefault()
      current!.error.content = "Task is limited to 32,000 characters. Paste a shorter message."
      current!.error.fg = color.error
    }
  }

  return {
    open,
    close,
    navigate,
    input,
    prompt,
    track,
    reveal,
    submit,
    compose,
    keypress,
    paste,
    resize: ui.resize,
  }
}

export type Dialogs = ReturnType<typeof createDialogs>
