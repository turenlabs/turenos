import { describe, expect, test } from "bun:test"
import { Token } from "@turenlabs/core/util/token"

describe("Token.estimate", () => {
  test("prices dense non-ASCII text by UTF-8 bytes rather than UTF-16 length", () => {
    // CJK is ~1-2 tokens per character in real tokenizers. UTF-16 length priced it at 0.25,
    // a 4-8x undercount that let requests past the compaction gate into provider overflows.
    expect(Token.estimate("好".repeat(1_000))).toBe(750)
    expect(Token.estimate("x".repeat(1_000))).toBe(250)
  })
})
