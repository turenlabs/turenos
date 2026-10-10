import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core"
import { ANVIL_ASPECT, WORDMARK_ROWS, createAnvil } from "./anvil"
import { matchesKey } from "./keys"
import { color } from "./theme"

/** The widest anvil, in columns; a wider one costs more to draw and shows no more detail. */
const WIDEST = 100

/**
 * Ctrl+H hides the screen behind the wordmark and the turning anvil until a click, Esc or Ctrl+H brings it back.
 * It takes every other key, so nothing types into the hidden screen; with reduced motion the anvil stands still.
 */
export function createScreensaver(renderer: CliRenderer, parent: Renderable, still: () => boolean) {
  const view = new BoxRenderable(renderer, {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    // Above the footer and every dialog.
    zIndex: 1000,
    backgroundColor: color.bg,
    visible: false,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    onMouseDown: (event) => {
      event.preventDefault()
      hide()
    },
    // The editor underneath keeps its focus, and so would show its cursor through the anvil.
    renderAfter: () => renderer.setCursorPosition(0, 0, false),
  })
  const anvil = createAnvil(renderer, { background: color.bg, still })
  view.add(anvil.view)
  view.add(new TextRenderable(renderer, { content: "Click, Esc or Ctrl+H to return", fg: color.muted, marginTop: 1 }))
  parent.add(view)
  // The wordmark, the anvil under it, and the hint fill the screen up to the widest anvil.
  const fit = () => {
    const columns = Math.min(renderer.width - 4, WIDEST, (renderer.height - 4 - WORDMARK_ROWS) * ANVIL_ASPECT)
    anvil.size(Math.max(2, Math.floor(columns / ANVIL_ASPECT)))
  }
  view.once(RenderableEvents.DESTROYED, () => renderer.off("resize", fit))

  function show() {
    fit()
    view.visible = true
    renderer.on("resize", fit)
    anvil.play()
  }

  function hide() {
    view.visible = false
    renderer.off("resize", fit)
    anvil.stop()
  }

  return {
    show,
    get visible() {
      return view.visible
    },
    /** Ctrl+H shows or hides the screensaver, and while it shows it takes every key; true when it took this one. */
    key(key: KeyEvent) {
      const toggle = ctrlH(key)
      if (!view.visible) {
        if (toggle) show()
        return toggle
      }
      if (toggle || matchesKey(key, "escape") || matchesKey(key, "c", { ctrl: true })) hide()
      return true
    },
  }
}

/**
 * Ctrl+H, which terminals without the kitty keyboard protocol (tmux among them) send as the backspace byte 0x08;
 * Backspace itself sends 0x7f. A terminal that sends 0x08 for Backspace or Ctrl+Backspace shows the screensaver
 * on that key instead.
 */
function ctrlH(key: KeyEvent) {
  return (
    matchesKey(key, "h", { ctrl: true }) || (key.eventType !== "release" && key.name === "backspace" && key.raw === "\b")
  )
}
