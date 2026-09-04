import { describe, expect, test } from "bun:test"
import { ProductLinks } from "./product-links"

describe("ProductLinks", () => {
  test("points every help action at the public TurenOS repository", () => {
    for (const value of Object.values(ProductLinks)) {
      expect(new URL(value).hostname).toBe("github.com")
      expect(value).toContain("/turenlabs/turenos")
      expect(value).not.toContain("/turenlabs/forge")
    }
  })
})
