import { expect, test } from "bun:test"
import { detectOutputEncoding } from "./runtime"

test("detects UTF-16LE output without a BOM at the heuristic boundary", () => {
  expect(detectOutputEncoding(Uint8Array.from([65, 0, 66, 1, 67, 1]))).toBe("utf-16le")
  expect(detectOutputEncoding(Uint8Array.from([65, 0, 66, 0, 0]))).toBe("utf-16le")
})

test("keeps BOM precedence and rejects ambiguous or insufficient output", () => {
  expect(detectOutputEncoding(Uint8Array.from([0xff, 0xfe]))).toBe("utf-16le")
  expect(detectOutputEncoding(Uint8Array.from([0, 0, 65, 1, 66, 1]))).toBe("utf-8")
  expect(detectOutputEncoding(Uint8Array.from([65, 66, 67, 68]))).toBe("utf-8")
  expect(detectOutputEncoding(Uint8Array.from([65, 0]))).toBe("utf-8")
})
