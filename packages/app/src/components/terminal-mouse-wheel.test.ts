import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Ghostty, Terminal } from "ghostty-web"
import { SerializeAddon } from "@/addons/serialize"

let ghostty: Ghostty
const terminals: Terminal[] = []
const getContext = HTMLCanvasElement.prototype.getContext

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextType: string, options?: unknown) {
    const context = getContext.call(this, contextType as "2d", options) as CanvasRenderingContext2D | null
    if (contextType !== "2d" || !context) return context
    context.measureText = (text: string) =>
      ({
        width: text.length * 8,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 2,
      }) as TextMetrics
    return context
  } as typeof HTMLCanvasElement.prototype.getContext
  ghostty = await Ghostty.load()
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = getContext
})

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose())
  document.body.innerHTML = ""
})

const createTerminal = () => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const term = new Terminal({ cols: 80, rows: 24, ghostty, smoothScrollDuration: 0 })
  const addon = new SerializeAddon()
  term.loadAddon(addon)
  term.open(container)
  terminals.push(term)
  const data: string[] = []
  term.onData((value) => data.push(value))
  return { container, data, term, addon }
}

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => {
    term.write(data, resolve)
  })

const wheel = (container: HTMLElement, deltaY: number) => {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY })
  Object.defineProperties(event, {
    clientX: { value: 1 },
    clientY: { value: 1 },
  })
  container.querySelector("canvas")?.dispatchEvent(event)
  return event
}

describe("ghostty terminal mouse wheel routing", () => {
  test("keeps normal-screen wheel input in terminal scrollback", async () => {
    const { container, data, term } = createTerminal()
    await write(term, Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\r\n"))
    const before = term.getViewportY()
    const event = wheel(container, -99)

    expect(data).toEqual([])
    expect(event.defaultPrevented).toBe(true)
    expect(term.getViewportY()).toBeGreaterThan(before)
  })

  test("keeps alternate-screen fallback arrows when mouse tracking is disabled", async () => {
    const { container, data, term } = createTerminal()
    await write(term, "\x1b[?1049h")

    wheel(container, -99)

    expect(data).toEqual(["\x1b[A", "\x1b[A", "\x1b[A"])
  })

  test("sends one SGR wheel event to a mouse-aware full-screen terminal app", async () => {
    const { container, data, term } = createTerminal()
    await write(term, "\x1b[?1049h\x1b[?1000h\x1b[?1006h")

    const event = wheel(container, -99)

    expect(data).toEqual(["\x1b[<64;1;1M"])
    expect(event.defaultPrevented).toBe(true)

    data.length = 0
    wheel(container, -0.5)
    wheel(container, 0.5)
    expect(data).toEqual(["\x1b[<64;1;1M", "\x1b[<65;1;1M"])
  })

  test("preserves legacy X10 wheel encoding", async () => {
    const { container, data, term } = createTerminal()
    await write(term, "\x1b[?1000h")

    wheel(container, 99)

    expect(data).toEqual(["\x1b[Ma!!"])
  })

  test("does not turn a horizontal trackpad gesture into wheel-down", async () => {
    const { container, data, term } = createTerminal()
    await write(term, "\x1b[?1000h\x1b[?1006h")

    const event = wheel(container, 0)

    expect(data).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  test("returns to alternate-screen arrows when an app disables mouse tracking", async () => {
    const { container, data, term } = createTerminal()
    await write(term, "\x1b[?1049h\x1b[?1000h\x1b[?1006h")
    wheel(container, -99)
    data.length = 0

    await write(term, "\x1b[?1000l\x1b[?1006l")
    const event = wheel(container, -99)

    expect(data).toEqual(["\x1b[A", "\x1b[A", "\x1b[A"])
    expect(event.defaultPrevented).toBe(true)
  })

  test("keeps a custom wheel handler ahead of mouse reporting", async () => {
    const { container, data, term } = createTerminal()
    await write(term, "\x1b[?1000h\x1b[?1006h")
    let handled = 0
    term.attachCustomWheelEventHandler(() => {
      handled += 1
      return true
    })

    const event = wheel(container, -99)

    expect(handled).toBe(1)
    expect(data).toEqual([])
    expect(event.defaultPrevented).toBe(true)
  })
})

// The desktop app persists terminals via SerializeAddon.serialize() on unmount
// and writes the snapshot back on remount (persistTerminal in terminal.tsx),
// while the WebSocket replay resumes from the persisted byte cursor - so the
// snapshot is the only carrier of the terminal app's modes. Dropping them made
// ghostty's alt-screen wheel fallback sends arrow keys, which full-screen terminal apps
// binds to prompt-history navigation ("scrolling navigates back via history").
describe("ghostty terminal mouse wheel routing after snapshot restore", () => {
  test("keeps SGR wheel reporting for a restored mouse-aware terminal app instead of history arrows", async () => {
    const source = createTerminal()
    await write(source.term, "\x1b[?1049h\x1b[?1000h\x1b[?1006h")

    const { container, data, term } = createTerminal()
    await write(term, source.addon.serialize())

    expect(term.hasMouseTracking()).toBe(true)
    const event = wheel(container, -99)

    expect(data).toEqual(["\x1b[<64;1;1M"])
    expect(data).not.toContain("\x1b[A")
    expect(event.defaultPrevented).toBe(true)
  })

  test("keeps alternate-screen fallback arrows for a restored terminal app without mouse tracking", async () => {
    const source = createTerminal()
    await write(source.term, "\x1b[?1049h")

    const { container, data, term } = createTerminal()
    await write(term, source.addon.serialize())

    wheel(container, -99)

    expect(data).toEqual(["\x1b[A", "\x1b[A", "\x1b[A"])
  })

  test("keeps normal-screen wheel input in scrollback for a restored shell", async () => {
    const source = createTerminal()
    await write(source.term, Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\r\n"))

    const { container, data, term } = createTerminal()
    await write(term, source.addon.serialize())

    const before = term.getViewportY()
    const event = wheel(container, -99)

    expect(data).toEqual([])
    expect(event.defaultPrevented).toBe(true)
    expect(term.getViewportY()).toBeGreaterThan(before)
  })
})
