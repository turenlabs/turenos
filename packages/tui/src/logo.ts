import { StyledText, bg, fg } from "@opentui/core"
import { color } from "./theme"
import { large, medium, palette, small, xl } from "./logo/art"

type Pixels = (string | undefined)[][]

/** "TurenOS" as the desktop writes it, five pixels wide and seven tall; lowercase letters sit on a five-pixel height. */
const letters = [
  ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
  ["00000", "00000", "10110", "11001", "10001", "10001", "10001"],
  ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
]

// The mark's cream and blue, shaded from the top of each letter down.
const cream = ["#fbf8f0", "#f6f2e7", "#f3efe3", "#e9e3d3", "#ddd6c4", "#d0c8b4", "#c2baa5"]
const blue = ["#c8daf7", "#a9c4ef", "#8aaee6", "#6c98dd", "#4f82d3", "#3a6fc4", "#2f63b5"]
const shadow = palette.n!

/** Columns the compact logo takes with the small anvil beside the wordmark. */
const COMPACT_WITH_MARK = 52
/** A dialog's frame and borders take six of the terminal's columns. */
const DIALOG_CHROME = 6
/** Terminal rows from which the wide logo carries the large anvil, the desktop's mark itself. */
const TALL = 44

/**
 * The New session and server picker logo: the anvil beside the wordmark. The wide form has the medium anvil, or the
 * large one on a terminal of `rows` from `TALL`; the compact one has the small anvil when `columns` leaves room for
 * it, else the wordmark alone.
 */
export function turenLogo(wide: boolean, columns = Number.POSITIVE_INFINITY, rows = 0) {
  if (wide && rows >= TALL) return composed({ anvil: large, left: 34, top: 12, width: 75, height: 16, shaded: true })
  if (wide) return composed({ anvil: medium, left: 25, top: 5, width: 66, height: 9, shaded: true })
  const anvil = columns - DIALOG_CHROME >= COMPACT_WITH_MARK ? small : undefined
  const width = anvil ? COMPACT_WITH_MARK : 41
  return composed({ anvil, left: anvil ? 11 : 0, top: 0, width, height: 4, shaded: false })
}

/** The anvil at the left, and the wordmark at `left` and `top` in pixels; `shaded` gives the letters their shadow. */
function composed(logo: {
  anvil: string[] | undefined
  left: number
  top: number
  width: number
  height: number
  shaded: boolean
}) {
  const pixels: Pixels = Array.from({ length: logo.height * 2 }, () => Array(logo.width))
  if (logo.anvil) draw(pixels, logo.anvil)
  drawWordmark(pixels, logo.left, logo.top, logo.shaded)
  return { width: logo.width, height: logo.height, content: halfBlocks(pixels, logo.width, logo.height, color.panel) }
}

/** The largest anvil that fits in `rows` terminal rows, for the welcome screen on the main pane's background. */
export function welcomeMark(rows: number) {
  const art = [xl, large, medium].find((item) => item.length / 2 <= rows) ?? small
  const width = art[0]!.length
  const height = art.length / 2
  const pixels: Pixels = Array.from({ length: art.length }, () => Array(width))
  draw(pixels, art)
  return { width, height, content: halfBlocks(pixels, width, height, color.bg) }
}

function draw(pixels: Pixels, art: string[]) {
  art.forEach((row, y) =>
    [...row].forEach((pixel, x) => {
      if (palette[pixel]) pixels[y]![x] = palette[pixel]
    }),
  )
}

function drawWordmark(pixels: Pixels, left: number, top: number, shaded: boolean) {
  for (const [index, letter] of letters.entries()) {
    for (const [y, row] of letter.entries()) {
      for (const [x, bit] of [...row].entries()) {
        if (bit !== "1") continue
        if (shaded) pixels[top + y + 1]![left + index * 6 + x + 1] ??= shadow
        pixels[top + y]![left + index * 6 + x] = (index < 5 ? cream : blue)[y]
      }
    }
  }
}

// Half blocks make square pixels, with independent colors above and below; `background` fills an empty half.
function halfBlocks(pixels: Pixels, width: number, height: number, background: string) {
  return new StyledText(
    Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, x) => {
        const upper = pixels[row * 2]![x]
        const lower = pixels[row * 2 + 1]![x]
        const pixel = upper ? bg(lower ?? background)(fg(upper)("▀")) : fg(lower ?? background)(lower ? "▄" : " ")
        return x === width - 1 && row < height - 1 ? [pixel, fg(color.text)("\n")] : [pixel]
      }).flat(),
    ).flat(),
  )
}
