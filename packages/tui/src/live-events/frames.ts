const MAX_FRAME = 1024 * 1024

/** Parser state for one server-sent event stream. */
export type Frames = {
  line: Uint8Array
  decoder: TextDecoder
  length: number
  frameBytes: number
  carriageReturn: boolean
  /** Dropping the rest of an oversized or undecodable frame, up to its blank line. */
  skipping: boolean
  data: string[]
}

export function newFrames(): Frames {
  // Count wire bytes per frame, not per connection. Keep partial UTF-8 bytes until a complete line arrives.
  return {
    line: new Uint8Array(MAX_FRAME),
    decoder: new TextDecoder("utf-8", { fatal: true }),
    length: 0,
    frameBytes: 0,
    carriageReturn: false,
    skipping: false,
    data: [],
  }
}

/**
 * Feeds one wire byte; returns the joined `data:` lines when it completes a frame.
 * A frame over 1 MiB or with invalid UTF-8 is dropped whole, so one bad event never ends the stream.
 */
export function pushByte(f: Frames, byte: number): string | undefined {
  const lineEnd = byte === 10 || byte === 13
  if (f.carriageReturn && byte === 10) {
    f.carriageReturn = false
    // The CR already ended this line, so an overflow here skips only what remains of the frame.
    if (!f.skipping && f.frameBytes && ++f.frameBytes > MAX_FRAME) skipRest(f)
    return
  }
  f.carriageReturn = byte === 13
  if (!f.skipping && ++f.frameBytes > MAX_FRAME) {
    overflow(f, lineEnd)
    return
  }
  if (f.skipping) {
    skipByte(f, lineEnd)
    return
  }
  if (!lineEnd) {
    f.line[f.length++] = byte
    return
  }
  const text = decode(f)
  f.length = 0
  if (text === undefined) return
  if (text === "") {
    f.frameBytes = 0
    const payload = f.data
    f.data = []
    return payload.length ? payload.join("\n") : undefined
  }
  if (text === "data" || text.startsWith("data:")) {
    const value = text.slice(5)
    f.data.push(value.startsWith(" ") ? value.slice(1) : value)
  }
}

/** While skipping, `length` counts the current line's bytes so a blank line ends the frame. */
function skipByte(f: Frames, lineEnd: boolean) {
  if (!lineEnd) {
    f.length++
    return
  }
  if (f.length === 0) {
    f.skipping = false
    f.frameBytes = 0
    return
  }
  f.length = 0
}

/** The byte that put the frame over the limit: drop the frame, and skip the rest when more is coming. */
function overflow(f: Frames, lineEnd: boolean) {
  if (lineEnd && f.length === 0) {
    // The blank line that ends this frame is the byte over the limit: the next frame starts clean.
    f.data = []
    f.frameBytes = 0
    return
  }
  skipRest(f)
  // Mid-line, nonzero so the line that overflowed is not mistaken for the blank line that ends the frame.
  if (!lineEnd) f.length = 1
}

/** Drops the frame so far and skips what remains of it; the current line has already ended. */
function skipRest(f: Frames) {
  f.skipping = true
  f.data = []
  f.length = 0
}

function decode(f: Frames): string | undefined {
  try {
    return f.decoder.decode(f.line.subarray(0, f.length))
  } catch {
    skipRest(f)
    return undefined
  }
}
