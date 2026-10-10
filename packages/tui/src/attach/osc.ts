import type { OscState } from "./types"

const ESC = "\x1b"
/** The 8-bit OSC introducer, which some terminals also honour in UTF-8. */
const OSC8 = "\u009d"
const INTRODUCER = /[\x1b\u009d]/g
/** Icon and window titles (0, 1, 2) and the clipboard (52): a PTY program must not set them on the host terminal. */
const BLOCKED = new Set([0, 1, 2, 52])
/** What ends an OSC string, as a terminal reads it: BEL, the 8-bit ST, or the cancel controls CAN and SUB. */
const ENDS = new Set(["\x07", "\u009c", "\x18", "\x1a"])

/**
 * PTY output without the OSC sequences in BLOCKED, wherever the WebSocket messages split them. A dropped
 * sequence ends where the host terminal would end it, and nothing of it is kept, so its length costs no memory.
 * Other OSCs pass unchanged. Selectors over 64 digits are dropped to bound retained memory.
 */
export function filterOsc(osc: OscState, text: string) {
  const input = osc.held + text
  osc.held = ""
  let out = ""
  let at = 0
  while (at < input.length) {
    if (osc.dropping) {
      at = skip(osc, input, at)
      continue
    }
    if (osc.selector) {
      const selector = osc.selector
      while (at < input.length && input[at]! >= "0" && input[at]! <= "9") {
        selector.value = Math.min(53, selector.value * 10 + Number(input[at]))
        selector.digits++
        selector.prefix += input[at++]
        if (selector.digits > 64) break
      }
      if (selector.digits > 64) {
        osc.selector = undefined
        osc.dropping = true
        continue
      }
      if (at === input.length) return out
      const next = input[at]!
      osc.dropping =
        selector.digits > 0 && BLOCKED.has(selector.value) && (next === ";" || next === ESC || ENDS.has(next))
      if (!osc.dropping) out += selector.prefix
      osc.selector = undefined
      continue
    }
    INTRODUCER.lastIndex = at
    const start = INTRODUCER.exec(input)?.index
    if (start === undefined) return out + input.slice(at)
    out += input.slice(at, start)
    const body = start + (input[start] === OSC8 ? 1 : 2)
    // A lone final ESC may begin an OSC that the next message completes.
    if (input[start] === ESC && start + 1 === input.length) {
      osc.held = ESC
      return out
    }
    if (input[start] === ESC && input[start + 1] !== "]") {
      out += ESC
      at = start + 1
      continue
    }
    osc.selector = { prefix: input.slice(start, body), value: 0, digits: 0 }
    at = body
  }
  return out
}

/** Drops a sequence's characters up to its end, and returns where output resumes. */
function skip(osc: OscState, input: string, at: number) {
  for (let index = at; index < input.length; index++) {
    const char = input[index]!
    if (!ENDS.has(char) && char !== ESC) continue
    // ESC \ (ST) may be split across messages: hold the ESC until the next one says which it is.
    if (char === ESC && index + 1 === input.length) {
      osc.held = ESC
      return input.length
    }
    osc.dropping = false
    // ESC \ ends the string; any other escape also ends it and begins its own sequence, as xterm reads it.
    if (char === ESC) return input[index + 1] === "\\" ? index + 2 : index
    return index + 1
  }
  return input.length
}
