import { describe, expect, test } from "bun:test"
import { binarySnapshot } from "./binary-snapshot"

function hex(overrides: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  return binarySnapshot("hexview", input, {
    structured: { path: "/sample", offset: 16, length: 4, bytes: "7f454c46", ...overrides },
  })
}

function report(result: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    path: "/sample",
    schemaVersion: 1,
    operation: "disassemble",
    truncated: false,
    warnings: [],
    result: {
      bitness: 64,
      offset: 32,
      instructions: [
        { address: "0xfffffffffffffff0", bytes: "55", text: "push rbp" },
        { address: "0xfffffffffffffff1", bytes: "4889e5", text: "mov rbp,rsp" },
      ],
      ...result,
    },
    ...overrides,
  })
}

describe("binarySnapshot", () => {
  test("decodes raw hex before formatted content and retains continuation", () => {
    expect(hex({ content: "not parsed", nextOffset: 20 })).toEqual({
      path: "/sample",
      kind: "hex",
      rows: [{ offset: 16, bytes: ["7f", "45", "4c", "46"] }],
      nextOffset: 20,
      warnings: [],
    })
    expect(hex({ length: 17, bytes: "00".repeat(17) })?.rows.map((row) => row.bytes.length)).toEqual([16, 1])
    expect(hex({ length: 17, bytes: "00".repeat(17) }, { width: 8 })?.rows.map((row) => row.offset)).toEqual([
      16, 24, 32,
    ])
  })

  test("reads shipped padded hex history including ASCII pipes", () => {
    expect(
      hex({ bytes: undefined, content: "0x00000010  7f 45 4c 46                                       |.ELF|" })
        ?.rows[0]?.bytes,
    ).toEqual(["7f", "45", "4c", "46"])
    expect(hex({ bytes: undefined, length: 1, content: "0x00000010  7c   |||" })?.rows[0]?.bytes).toEqual(["7c"])
  })

  test("rejects malformed, missing and partial hex bytes", () => {
    for (const bytes of ["7", "zz", "7f 45", "7f", null]) expect(hex({ bytes })).toBeUndefined()
    for (const content of [
      "0x00000010  7f 4  |..|",
      "0x00000011  7f 45 4c 46  |.ELF|",
      "0x00000010  7f 45 4c 46  |oops|",
    ])
      expect(hex({ bytes: undefined, content })).toBeUndefined()
    expect(hex({}, { width: 0 })).toBeUndefined()
    expect(hex({ nextOffset: 21 })).toBeUndefined()
  })

  test("keeps exact virtual addresses separate from cumulative file offsets", () => {
    const snapshot = binarySnapshot("disassemble", {}, { structured: { path: "/sample", report: report() } })
    expect(snapshot?.kind).toBe("disassembly")
    expect(snapshot?.bitness).toBe(64)
    expect(snapshot?.rows).toEqual([
      { offset: 32, address: "0xfffffffffffffff0", bytes: ["55"], text: "push rbp" },
      { offset: 33, address: "0xfffffffffffffff1", bytes: ["48", "89", "e5"], text: "mov rbp,rsp" },
    ])
  })

  test("uses JSON output fallback and preserves warnings and truncation", () => {
    expect(
      binarySnapshot("disassemble", {}, {}, report({}, { warnings: ["Incomplete code"], truncated: true }))?.warnings,
    ).toEqual(["Incomplete code", "Disassembly report was truncated."])
    expect(binarySnapshot("disassemble", {}, { structured: { report: "corrupt" } }, report())).toBeUndefined()
  })

  test("rejects corrupt JSON and wrong report shapes", () => {
    for (const output of ["{", "null", "[]", "42", report({}, { operation: "inspect" }), report({}, { warnings: [1] })])
      expect(binarySnapshot("disassemble", {}, {}, output)).toBeUndefined()
    expect(binarySnapshot("other", {}, {}, report())).toBeUndefined()
    expect(binarySnapshot("hexview", {}, {})).toBeUndefined()
  })

  test("rejects unsafe, negative, fractional and overflowing offsets", () => {
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, "32"]) {
      expect(hex({ offset })).toBeUndefined()
      expect(binarySnapshot("disassemble", {}, {}, report({ offset }))).toBeUndefined()
    }
    expect(hex({ nextOffset: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined()
  })

  test("rejects partial instructions rather than dropping or inventing bytes", () => {
    for (const instruction of [
      null,
      { address: "0x1", bytes: "5", text: "push" },
      { address: 1, bytes: "55", text: "push" },
      { address: "0x1", bytes: "55" },
    ])
      expect(binarySnapshot("disassemble", {}, {}, report({ instructions: [instruction] }))).toBeUndefined()
  })

  test("enforces byte, instruction and input text caps", () => {
    expect(hex({ length: 65536, bytes: "00".repeat(65536) })?.rows).toHaveLength(4096)
    expect(hex({ length: 65537, bytes: "00".repeat(65537) })).toBeUndefined()
    const instruction = { address: "0x0", bytes: "90", text: "nop" }
    expect(
      binarySnapshot("disassemble", {}, {}, report({ instructions: Array(4096).fill(instruction) }))?.rows,
    ).toHaveLength(4096)
    expect(
      binarySnapshot("disassemble", {}, {}, report({ instructions: Array(4097).fill(instruction) })),
    ).toBeUndefined()
    expect(
      binarySnapshot("disassemble", {}, {}, report({ instructions: [{ ...instruction, bytes: "90".repeat(4097) }] })),
    ).toBeUndefined()
    expect(binarySnapshot("disassemble", {}, {}, " ".repeat(1024 * 1024 + 1))).toBeUndefined()
    expect(binarySnapshot("disassemble", {}, {}, report({}, { warnings: ["é".repeat(600000)] }))).toBeUndefined()
    expect(hex({ bytes: undefined, content: " ".repeat(1024 * 1024 + 1) })).toBeUndefined()
  })
})
