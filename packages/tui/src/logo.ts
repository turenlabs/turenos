import { StyledText, bg, fg } from "@opentui/core"
import { color } from "./theme"

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

const WIDTH = 41
const HEIGHT = 4

/** The TurenOS wordmark, for New session and the server picker. */
export function turenLogo() {
  const pixels = Array.from({ length: HEIGHT * 2 }, () => Array<string | undefined>(WIDTH))
  for (const [index, letter] of letters.entries()) {
    for (const [y, row] of letter.entries()) {
      for (const [x, bit] of [...row].entries()) {
        if (bit === "1") pixels[y]![index * 6 + x] = (index < 5 ? cream : blue)[y]
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, content: halfBlocks(pixels) }
}

// Half blocks make square pixels, with independent colors above and below.
function halfBlocks(pixels: (string | undefined)[][]) {
  return new StyledText(
    Array.from({ length: HEIGHT }, (_, row) =>
      Array.from({ length: WIDTH }, (_, x) => {
        const upper = pixels[row * 2]![x]
        const lower = pixels[row * 2 + 1]![x]
        const pixel = upper ? bg(lower ?? color.panel)(fg(upper)("▀")) : fg(lower ?? color.panel)(lower ? "▄" : " ")
        return x === WIDTH - 1 && row < HEIGHT - 1 ? [pixel, fg(color.text)("\n")] : [pixel]
      }).flat(),
    ).flat(),
  )
}
