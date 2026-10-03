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

  test("rejects a frame larger than 1 MiB", () => {
    expect(() => feed(`data: ${"x".repeat(1024 * 1024)}\n`)).toThrow("live event frame exceeds 1 MiB")
  })
})
