import { describe, expect, test } from "bun:test"
import { Npm } from "@turenlabs/core/npm"

const win = process.platform === "win32"

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@forge/acme")).toBe("@forge/acme")
    expect(Npm.sanitize("@forge/acme@1.0.0")).toBe("@forge/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.which", () => {
  test("rejects packages outside TurenOS's formatter and LSP package set", async () => {
    await expect(Npm.which("@turenlabs/plugin")).resolves.toBeUndefined()
  })
})
