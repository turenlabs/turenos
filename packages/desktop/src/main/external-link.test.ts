import { describe, expect, test } from "bun:test"
import { externalHttpUrl } from "./external-link"

describe("externalHttpUrl", () => {
  test("allows normalized HTTP and HTTPS links", () => {
    expect(externalHttpUrl("https://example.com/security?q=1")).toBe("https://example.com/security?q=1")
    expect(externalHttpUrl("http://example.com")).toBe("http://example.com/")
  })

  test("rejects credentials and non-web schemes", () => {
    expect(externalHttpUrl("https://user:secret@example.com/")).toBeUndefined()
    expect(externalHttpUrl("javascript:alert(1)")).toBeUndefined()
    expect(externalHttpUrl("file:///etc/passwd")).toBeUndefined()
    expect(externalHttpUrl("mailto:security@example.com")).toBeUndefined()
  })

  test("rejects invalid and oversized input", () => {
    expect(externalHttpUrl("not a url")).toBeUndefined()
    expect(externalHttpUrl(`https://example.com/${"x".repeat(4096)}`)).toBeUndefined()
    expect(externalHttpUrl(null)).toBeUndefined()
    expect(externalHttpUrl({ href: "https://example.com" })).toBeUndefined()
  })
})
