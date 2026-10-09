import { StyledText, bg, fg } from "@opentui/core"
import { color } from "./theme"

type Pixels = (string | undefined)[][]

const letters = [
  ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
]

// The desktop mark's colors: an engraved cream anvil with blue shading, standing in blue water.
const cream = ["#fbf8f0", "#f6f2e7", "#f3efe3", "#e9e3d3", "#ddd6c4", "#d0c8b4", "#c2baa5"]
const blue = ["#c8daf7", "#a9c4ef", "#8aaee6", "#6c98dd", "#4f82d3", "#3a6fc4", "#2f63b5"]
const shadow = "#172a52"

const anvilPalette: Record<string, string> = {
  c: "#f3efe3",
  h: "#96b2de",
  b: "#2f63b5",
  d: shadow,
  w: "#4a7fd4",
  W: "#c8daf7",
}

/** The desktop's anvil (`turen-mark.png`) as pixel art: horn, face with its hardy hole, waist, foot, water skirt. */
const anvil = [
  ".......ccccccccccdcc",
  "....cchhhhhhhhhhhhhb",
  "ccccccccccccccccccbb",
  "..bbbbbbcccccccccbbd",
  ".......bbdcccccdbbd.",
  ".........dcccccbd...",
  "..........ccccbb....",
  ".........dccccbbd...",
  "........cccccccbbb..",
  "........ccccccccbbb.",
  "....w..wccccccccbbww",
  "..wwWw.wccccccccbbWw",
  ".wWwhwWwwbbbbbbbbwhW",
  "wWwwwWwhwWwwwWwwWwww",
  ".wwhwwWwwwhwwwWwhwW.",
  "..W.wWw.wWww.Ww.w.W.",
  "....W..W.W..W..W....",
  ".........W......W...",
]

const smallAnvil = [
  "...ccccdc.",
  ".cchhhhhhb",
  "cccccccccb",
  "..bbcccbd.",
  "....cccb..",
  "...ccccbb.",
  ".wwccccbbw",
  "wWwhwWwhWw",
]

/** Columns the compact logo takes with the small anvil beside the wordmark. */
const COMPACT_WITH_MARK = 52
/** A dialog's frame and borders take six of the terminal's columns. */
const DIALOG_CHROME = 6

/**
 * The New session and server picker logo: the anvil beside the wordmark. The wide form has the full anvil; the
 * compact one has the small anvil when `columns` leaves room for it, else the wordmark alone.
 */
export function turenLogo(wide: boolean, columns = Number.POSITIVE_INFINITY) {
  const mark = wide || columns - DIALOG_CHROME >= COMPACT_WITH_MARK
  const width = wide ? 66 : mark ? COMPACT_WITH_MARK : 41
  const height = wide ? 9 : 4
  const pixels: Pixels = Array.from({ length: height * 2 }, () => Array(width))
  if (mark) draw(pixels, wide ? anvil : smallAnvil, 0, 0)
  drawWordmark(pixels, wide ? 25 : mark ? 11 : 0, wide ? 5 : 0, wide)
  return { width, height, content: halfBlocks(pixels, width, height, color.panel) }
}

/** The small anvil alone, for the welcome screen on the main pane's background. */
export function anvilMark() {
  const pixels: Pixels = Array.from({ length: smallAnvil.length }, () => Array(smallAnvil[0]!.length))
  draw(pixels, smallAnvil, 0, 0)
  const width = smallAnvil[0]!.length
  const height = smallAnvil.length / 2
  return { width, height, content: halfBlocks(pixels, width, height, color.bg) }
}

function draw(pixels: Pixels, art: string[], left: number, top: number) {
  art.forEach((row, y) =>
    [...row].forEach((pixel, x) => {
      if (anvilPalette[pixel]) pixels[top + y]![left + x] = anvilPalette[pixel]
    }),
  )
}

function drawWordmark(pixels: Pixels, left: number, top: number, wide: boolean) {
  for (const [index, letter] of letters.entries()) {
    for (const [y, row] of letter.entries()) {
      for (const [x, bit] of [...row].entries()) {
        if (bit !== "1") continue
        if (wide) pixels[top + y + 1]![left + index * 6 + x + 1] = shadow
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
