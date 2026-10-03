import { invalid } from "../response-validation"

/** Parser state for one server-sent event stream. */
export type Frames = {
  line: Uint8Array
  decoder: TextDecoder
  length: number
  frameBytes: number
  carriageReturn: boolean
  data: string[]
}

export function newFrames(): Frames {
  // Count wire bytes per frame, not per connection. Keep partial UTF-8 bytes until a complete line arrives.
  return {
    line: new Uint8Array(1024 * 1024),
    decoder: new TextDecoder("utf-8", { fatal: true }),
    length: 0,
    frameBytes: 0,
    carriageReturn: false,
    data: [],
  }
}

/** Feeds one wire byte; returns the joined `data:` lines when it completes a frame. */
export function pushByte(f: Frames, byte: number): string | undefined {
  if (f.carriageReturn && byte === 10) {
    f.carriageReturn = false
    if (f.frameBytes && ++f.frameBytes > f.line.length) invalid("live event frame exceeds 1 MiB")
    return
  }
  f.carriageReturn = byte === 13
  if (++f.frameBytes > f.line.length) invalid("live event frame exceeds 1 MiB")
  if (byte !== 10 && byte !== 13) {
    f.line[f.length++] = byte
    return
  }
  const text = f.decoder.decode(f.line.subarray(0, f.length))
  f.length = 0
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
