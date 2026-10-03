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

const gold = ["#fff3cd", "#ffdc89", "#ffc463", "#efa453", "#d88350", "#c96b49", "#bd5c51"]
const violet = ["#eee5ff", "#dfcbff", "#c8a6f2", "#b591e5", "#a57ad7", "#9265c5", "#8054ae"]

const pilotPalette: Record<string, string> = {
  c: "#28536e",
  a: "#62c9da",
  w: "#112436",
  v: "#24425b",
  g: "#ffd17a",
  p: "#543e73",
  P: "#ad89db",
}

const pilot = [
  ".........g.........",
  ".........g.........",
  "......ggggggg......",
  "....ccccccccccc....",
  "...caaaaaaaaaaac...",
  "..caawwwwwwwwwaac..",
  ".caaawvvvvvvvwaaaac.",
  ".caaawvgggggvwaaac.",
  ".caaawvvvgvvvwaaac.",
  ".caaawvvvgvvvwaaac.",
  "..caawvvvvvvvwaac..",
  "...caawwwwwwwaac...",
  "....ccaaaaaaacc....",
  ".....ccccccccc.....",
  "....ppppgggpppp....",
  "...pPPPpgggpPPPp...",
  "..pPPPPpgggpPPPPp..",
  "...ppppppppppppp...",
]

export function turenLogo(wide: boolean) {
  const width = wide ? 70 : 41
  const height = wide ? 9 : 4
  const pixels: Pixels = Array.from({ length: height * 2 }, () => Array(width))
  drawWordmark(pixels, wide)
  if (wide) drawPilot(pixels)
  return { width, height, content: halfBlocks(pixels, width, height) }
}

function drawWordmark(pixels: Pixels, wide: boolean) {
  const left = wide ? 25 : 0
  const top = wide ? 5 : 0
  for (const [index, letter] of letters.entries()) {
    for (const [y, row] of letter.entries()) {
      for (const [x, bit] of [...row].entries()) {
        if (bit !== "1") continue
        if (wide) pixels[top + y + 1]![left + index * 6 + x + 1] = "#49344f"
        pixels[top + y]![left + index * 6 + x] = (index < 5 ? gold : violet)[y]
      }
    }
  }
}

function drawPilot(pixels: Pixels) {
  pilot.forEach((row, y) =>
    [...row].forEach((pixel, x) => {
      pixels[y]![x] = pilotPalette[pixel]
    }),
  )
  for (const [x, y] of [
    [23, 2],
    [68, 3],
    [67, 14],
  ]) {
    pixels[y!]![x!] = "#fff3cd"
    pixels[y!]![x! - 1] = "#28536e"
    pixels[y! + 1]![x!] = "#28536e"
  }
  for (let x = 26; x < 65; x++) pixels[15]![x] = x % 6 === 0 ? "#ffd17a" : "#28536e"
}

// Half blocks make square pixels, with independent colors above and below.
function halfBlocks(pixels: Pixels, width: number, height: number) {
  return new StyledText(
    Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, x) => {
        const upper = pixels[row * 2]![x]
        const lower = pixels[row * 2 + 1]![x]
        const pixel = upper ? bg(lower ?? color.panel)(fg(upper)("▀")) : fg(lower ?? color.panel)(lower ? "▄" : " ")
        return x === width - 1 && row < height - 1 ? [pixel, fg(color.text)("\n")] : [pixel]
      }).flat(),
    ).flat(),
  )
}
