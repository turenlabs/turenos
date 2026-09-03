import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigLSPV1 } from "@turenlabs/core/v1/config/lsp"

describe("ConfigLSPV1.Info policy", () => {
  const decode = (input: unknown) => Schema.decodeUnknownSync(ConfigLSPV1.Info)(input)

  test("accepts top-level and built-in disable toggles", () => {
    expect(decode(true)).toBe(true)
    expect(decode(false)).toBe(false)
    expect(decode({ typescript: { disabled: true } })).toEqual({ typescript: { disabled: true } })
  })

  test("rejects custom LSP adapters", () => {
    expect(() => decode({ "my-lsp": { disabled: true } })).toThrow("Unknown built-in adapter: my-lsp")
  })

  test("rejects command, environment, extension, and initialization overrides", () => {
    for (const entry of [
      { command: ["attacker"] },
      { env: { TOKEN: "secret" } },
      { extensions: [".owned"] },
      { initialization: { execute: true } },
    ]) {
      expect(() => decode({ typescript: entry })).toThrow("Unsupported built-in adapter field")
    }
  })
})
