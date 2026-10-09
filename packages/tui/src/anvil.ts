import { BoxRenderable, RGBA, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core"
import { createRenderer, type Cell } from "./anvil/render"
import { turenLogo } from "./logo"

/** Milliseconds between frames; the anvil turns slowly enough that ten a second look smooth. */
const FRAME = 100
/** Seconds the anvil takes to turn once. */
const TURN = 24
/** Where the anvil starts: three quarters on, its heel toward the viewer, as on the desktop's mark. */
const REST = -0.5
/** The anvil tipped toward the viewer, who sees the face from a little above. */
const TIP = -0.18
/** Columns per row of a stage that fits the anvil's profile, Braille dots being about square. */
export const ANVIL_ASPECT = 4.3
/** The rows the wordmark and the blank row under it take above the anvil. */
export const WORDMARK_ROWS = 5

/**
 * The TurenOS wordmark over the anvil, drawn in Braille as a lit solid and turning slowly on its upright axis,
 * after Codex's welcome animation. With `still`, the anvil stands three quarters on.
 */
export function createAnvil(renderer: CliRenderer, options: { background: string; still: () => boolean }) {
  const draw = createRenderer()
  const background = RGBA.fromHex(options.background)
  const shade = background.toInts().slice(0, 3) as [number, number, number]
  const view = new BoxRenderable(renderer, { flexDirection: "column", alignItems: "center", flexShrink: 0 })
  view.add(new TextRenderable(renderer, { ...turenLogo(options.background), marginBottom: 1, wrapMode: "none" }))
  const motion = { elapsed: 0, last: 0 }
  let cells: (Cell | undefined)[] | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const stage = new BoxRenderable(renderer, {
    flexShrink: 0,
    renderAfter: (buffer) => {
      if (!cells || cells.length !== stage.width * stage.height) cells = frame()
      cells.forEach((cell, index) => {
        if (!cell) return
        const color = RGBA.fromInts(cell.color >> 16, (cell.color >> 8) & 255, cell.color & 255)
        buffer.setCell(stage.x + (index % stage.width), stage.y + Math.floor(index / stage.width), cell.char, color, background)
      })
    },
  })
  view.add(stage)
  stage.once(RenderableEvents.DESTROYED, () => stop())

  function frame() {
    const angle = options.still() ? 0 : (motion.elapsed / TURN) * Math.PI * 2
    return draw.frame(stage.width, stage.height, { turn: REST + angle, tip: TIP, roll: 0 }, shade)
  }

  function tick() {
    const now = performance.now()
    motion.elapsed += Math.min(now - motion.last, 500) / 1000
    motion.last = now
    if (options.still()) stop()
    cells = frame()
    stage.requestRender()
  }

  function stop() {
    clearInterval(timer)
    timer = undefined
  }

  return {
    view,
    /** Turns the anvil from where it stopped, unless motion is reduced. */
    play() {
      if (timer || options.still()) return
      motion.last = performance.now()
      timer = setInterval(tick, FRAME)
    },
    stop,
    /** Sizes the anvil to `rows` rows; its width follows. */
    size(rows: number) {
      stage.height = rows
      stage.width = Math.round(rows * ANVIL_ASPECT)
    },
  }
}
