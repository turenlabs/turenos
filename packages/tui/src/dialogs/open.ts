import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { color } from "../theme"
import type { DialogContext } from "./context"

type Placement = { inline: boolean; docked: boolean; sidebar: boolean }

export function open(ctx: DialogContext, title: string, inline = false, height = 24, docked = false, sidebar = false) {
  if (ctx.state.modal) return undefined
  if (inline) ctx.hooks.rememberPosition()
  ctx.hooks.say("")
  const placement = { inline, docked, sidebar }
  const overlay = createOverlay(ctx, docked)
  attachOverlay(ctx, overlay, placement)
  const frame = createFrame(ctx, title, placement)
  overlay.add(frame)
  // Floating dialogs are as tall as their hint, so a one-line hint does not leave a blank row.
  const floating = !inline && !docked && !sidebar
  const error = new TextRenderable(ctx.renderer, {
    content: "Tab next · Shift+Tab back · Ctrl+Enter / Ctrl+S submit · Esc close",
    fg: color.muted,
    height: floating ? undefined : 2,
    flexShrink: 0,
  })
  // Floating and docked forms follow their content; the content's default 100% minimum would stretch them.
  const form = new ScrollBoxRenderable(ctx.renderer, {
    flexGrow: floating ? 0 : 1,
    minHeight: 1,
    ...(inline || sidebar ? {} : { flexShrink: 1 }),
    contentOptions: { flexDirection: "column", paddingRight: 1, ...(inline || sidebar ? {} : { minHeight: 0 }) },
  })
  frame.add(form)
  frame.add(error)
  ctx.state.modal = {
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
  ctx.ui.sidebarHeading.fg = color.muted
  ctx.ui.resize()
  return ctx.state.modal
}

function createOverlay(ctx: DialogContext, docked: boolean) {
  return new BoxRenderable(ctx.renderer, {
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
      const current = ctx.state.modal
      current?.fields[current.index]?.focus()
      if (!current) return
      let target = event.target
      while (target && !target.focusable) target = target.parent
      // Native autofocus runs after bubbling; blank form space must not steal field focus.
      if (target === current.form) event.preventDefault()
    },
  })
}

function attachOverlay(ctx: DialogContext, overlay: BoxRenderable, placement: Placement) {
  if (placement.inline) ctx.ui.main.add(overlay)
  if (placement.docked) ctx.ui.main.add(overlay, Math.max(0, ctx.ui.main.getChildren().indexOf(ctx.ui.actions)))
  if (!placement.inline && !placement.docked) (placement.sidebar ? ctx.ui.sidebar : ctx.ui.root).add(overlay)
}

function createFrame(ctx: DialogContext, title: string, placement: Placement) {
  const full = placement.inline || placement.docked || placement.sidebar
  return new BoxRenderable(ctx.renderer, {
    width: full ? "100%" : "95%",
    height: full ? "100%" : "auto",
    maxWidth: placement.docked ? undefined : placement.inline ? 88 : 70,
    maxHeight: placement.docked ? undefined : placement.inline ? 32 : Math.max(1, ctx.renderer.height - 2),
    border: placement.docked ? ["left"] : true,
    borderStyle: "rounded",
    borderColor: placement.docked ? color.accent : color.border,
    title: ` ${title} `,
    titleColor: color.text,
    padding: placement.docked ? 0 : 1,
    paddingX: placement.docked ? 2 : 1,
    backgroundColor: color.panel,
    flexDirection: "column",
    gap: placement.docked ? 0 : 1,
  })
}
