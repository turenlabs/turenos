import { describe, expect, test } from "bun:test"
import { ProxyPolicy } from "../src/proxy-policy"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

describe("proxy policy", () => {
  test("bounds literal expansion before allocating its result", () => {
    expect(ProxyPolicy.replaceLiteral("a.*b.*", ".*", "$&")).toBe("a$&b$&")
    expect(() => ProxyPolicy.replaceLiteral("a".repeat(65536), "a", "b".repeat(4096))).toThrow()
    expect(() => ProxyPolicy.replaceLiteral("a".repeat(65537), "a", "")).toThrow()
  })
  test("rule paths match only on the same origin with a strict path prefix", () => {
    expect(ProxyPolicy.matches("https://target.test/api/a", "https://target.test/api")).toBe(true)
    expect(ProxyPolicy.matches("https://target.test/api-other", "https://target.test/api")).toBe(false)
    expect(ProxyPolicy.matches("https://target.test:444/api/a", "https://target.test/api")).toBe(false)
    expect(ProxyPolicy.matches("https://target.test.attacker.test/api/a", "https://target.test/api")).toBe(false)
    for (const url of [
      "https://u:p@target.test/api",
      "file:///api",
      "forge-internal://renderer/api",
      "https://target.test/api/%2e%2e/private",
      "https://target.test/api%5cprivate",
      "https://target.test/api/%zz",
    ])
      expect(ProxyPolicy.matches(url, "https://target.test/api")).toBe(false)
  })

  test("protects loopback aliases only on the protected scheme and port", () => {
    const origins = ["http://127.0.0.1:4321", "https://dev.example.com"]
    const aliases = [
      "127.0.0.1",
      "localhost",
      "anything.localhost",
      "localhost.",
      "anything.localhost.",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[::ffff:127.0.0.1]",
      "[::ffff:127.255.255.255]",
      "127.0.0.2",
      "127.255.255.255",
      "2130706433",
      "127.1",
      "0x7f000001",
      "0177.0.0.1",
    ]
    expect(aliases.filter((host) => !ProxyPolicy.isProtected(new URL(`http://${host}:4321/path`), origins))).toEqual([])
    const allowed = [
      "http://localhost:3000",
      "https://localhost:4321",
      "http://example.com:4321",
      "http://localhost.example.com:4321",
      "https://other.example.com",
      "http://[::ffff:128.0.0.1]:4321",
      "http://128.0.0.1:4321",
      "http://127.example.com:4321",
    ]
    expect(allowed.filter((value) => ProxyPolicy.isProtected(new URL(value), origins))).toEqual([])
    expect(ProxyPolicy.isProtected(new URL("https://dev.example.com/path"), origins)).toBe(true)
    expect(ProxyPolicy.isProtected(new URL("http://localhost/path"), ["http://127.0.0.1:80"])).toBe(true)
    expect(ProxyPolicy.isProtected(new URL("https://localhost/path"), ["https://[::1]:443"])).toBe(true)
    expect(ProxyPolicy.isProtected(new URL("http://localhost:443"), ["https://127.0.0.1"])).toBe(false)
  })

  test("requires only a name to create a case", () => {
    const input = { id: "case_1", name: " Lab " }
    expect(ProxyPolicy.requireCreate(input).name).toBe("Lab")
    expect(() => ProxyPolicy.requireCreate({ ...input, name: " " })).toThrow()
  })

  test("bounds actual bytes and never sends an incomplete preview", () => {
    expect(ProxyPolicy.bytes({ data: "AAH/", encoding: "base64", state: "complete", size: 3 })).toEqual(
      new Uint8Array([0, 1, 255]),
    )
    expect(() => ProxyPolicy.bytes({ data: "x", encoding: "utf8", state: "truncated", size: 5 })).toThrow()
    expect(() =>
      ProxyPolicy.bytes({ data: "\u20ac".repeat(400_000), encoding: "utf8", state: "complete", size: 1_200_000 }),
    ).toThrow()
  })

  test("rejects invalid headers and transport-managed framing", () => {
    for (const name of ["Host", "content-length", "transfer-encoding", "connection", ":authority", "bad\nheader"])
      expect(() => ProxyPolicy.validateEdits({ headers: [{ name, value: "10" }] })).toThrow()
    expect(() => ProxyPolicy.validateEdits({ headers: [{ name: "Cookie", value: "[REDACTED]" }] })).toThrow()
    expect(() => ProxyPolicy.validateEdits({ headers: [{ name: "x-test", value: "x\r\nCookie: secret" }] })).toThrow()
    expect(() => ProxyPolicy.validateEdits({ status: 3.5 })).toThrow()
  })

  test("masks projections without mutating protected originals", () => {
    const message: SecurityProxy.Message = {
      url: "https://target.test/api?token=secret&search=okay",
      method: "POST",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
      body: { data: '{"password":"secret","message":"visible"}', encoding: "utf8", state: "complete", size: 45 },
    }
    const masked = ProxyPolicy.publicMessage(message)
    expect(JSON.stringify(masked)).not.toContain("secret")
    expect(masked.body.data).toContain("visible")
    expect(message.headers[0].value).toBe("Bearer secret")
    expect(message.url).toContain("token=secret")
  })

  test("masks JSON secrets across preview and capture boundaries", () => {
    const value = `{"message":"${"x".repeat(65500)}","token":"leak-boundary-secret-value"}`
    const preview = ProxyPolicy.publicBody({ data: value, encoding: "utf8", state: "complete", size: value.length })
    expect(preview.data.includes("leak")).toBe(false)
    expect(preview.data.endsWith('"token":"[REDACTED]"')).toBe(true)
    expect(preview.state).toBe("truncated")

    const partial = '{"password":"captured-secret\\'
    const truncated = ProxyPolicy.publicBody({ data: partial, encoding: "utf8", state: "truncated", size: 100 })
    expect(truncated.data.includes("captured-secret")).toBe(false)
    expect(truncated.state).toBe("truncated")
  })
})
