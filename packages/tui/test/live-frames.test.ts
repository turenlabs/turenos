import { describe, expect, test } from "bun:test"
import { newFrames, pushByte } from "../src/live-events/frames"

function feed(text: string, frames = newFrames()) {
  return [...new TextEncoder().encode(text)].flatMap((byte) => pushByte(frames, byte) ?? [])
}

describe("live event frames", () => {
  test("joins data lines of one frame across LF, CR and CRLF endings", () => {
    expect(feed("data: one\ndata:two\n\n")).toEqual(["one\ntwo"])
    expect(feed("data: a\r\n\r\ndata: b\r\rdata\n\n")).toEqual(["a", "b", ""])
  })

  test("ignores fields other than data and empty frames", () => {
    expect(feed("event: ping\nid: 1\n\n\n")).toEqual([])
  })

  test("keeps a multi-byte character split across feeds", () => {
    const frames = newFrames()
    const bytes = [...new TextEncoder().encode("data: é\n\n")]
    const payloads = bytes.flatMap((byte) => pushByte(frames, byte) ?? [])
    expect(payloads).toEqual(["é"])
  })

  test("drops a frame larger than 1 MiB and resumes at the next frame", () => {
    expect(feed(`data: ${"x".repeat(1024 * 1024)}\ndata: more\n\ndata: next\n\n`)).toEqual(["next"])
  })

  test("drops a frame with invalid UTF-8 and resumes at the next frame", () => {
    const frames = newFrames()
    const bad = [...new TextEncoder().encode("data: "), 0xff, ...new TextEncoder().encode("\ndata: x\n\n")]
    expect(bad.flatMap((byte) => pushByte(frames, byte) ?? [])).toEqual([])
    expect(feed("data: ok\n\n", frames)).toEqual(["ok"])
  })
})
