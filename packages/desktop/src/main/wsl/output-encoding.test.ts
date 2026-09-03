import { expect, test } from "bun:test"
import { detectOutputEncoding } from "./output-encoding"

test("detects WSL output encoding without misclassifying zero-heavy data", () => {
  expect(detectOutputEncoding(new Uint8Array([0xff, 0xfe]))).toBe("utf-16le")
  expect(detectOutputEncoding(new Uint8Array([0x41, 0, 0x42, 0]))).toBe("utf-16le")
  expect(detectOutputEncoding(new Uint8Array([0x41, 0, 0x42, 1, 0x43, 0, 0x44, 1]))).toBe("utf-16le")
  expect(detectOutputEncoding(new Uint8Array([0x41, 0, 0x42, 1, 0]))).toBe("utf-16le")
  expect(detectOutputEncoding(new Uint8Array([0, 0, 0, 0]))).toBe("utf-8")
  expect(detectOutputEncoding(new TextEncoder().encode("plain utf-8"))).toBe("utf-8")
  expect(detectOutputEncoding(new Uint8Array([0x41, 0]))).toBe("utf-8")
})
