import { describe, expect, test } from "bun:test"
import { normalizeLocalHttpEndpoint } from "@turenlabs/core/plugin/provider/local-endpoint"

const FALLBACK = "http://127.0.0.1:1"

describe("normalizeLocalHttpEndpoint", () => {
  test("falls back for missing or blank input", () => {
    expect(normalizeLocalHttpEndpoint(undefined, FALLBACK)).toBe(FALLBACK)
    expect(normalizeLocalHttpEndpoint(null, FALLBACK)).toBe(FALLBACK)
    expect(normalizeLocalHttpEndpoint("", FALLBACK)).toBe(FALLBACK)
    expect(normalizeLocalHttpEndpoint("   ", FALLBACK)).toBe(FALLBACK)
  })

  test("rejects non-string input outright", () => {
    expect(normalizeLocalHttpEndpoint(8080, FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint({}, FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint(["localhost"], FALLBACK)).toBeUndefined()
  })

  test("defaults schemeless input to http and strips a /v1 suffix", () => {
    expect(normalizeLocalHttpEndpoint("localhost:1234", FALLBACK)).toBe("http://localhost:1234")
    expect(normalizeLocalHttpEndpoint("127.0.0.1:8080/v1/", FALLBACK)).toBe("http://127.0.0.1:8080")
    expect(normalizeLocalHttpEndpoint("http://[::1]:9999", FALLBACK)).toBe("http://[::1]:9999")
    expect(normalizeLocalHttpEndpoint("https://localhost:9443/v1", FALLBACK)).toBe("https://localhost:9443")
  })

  test("rejects non-loopback hosts and lookalike hostnames", () => {
    expect(normalizeLocalHttpEndpoint("https://api.example.com", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("http://0.0.0.0:8080", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("http://localhost.evil.com", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("http://127.0.0.1.evil.com", FALLBACK)).toBeUndefined()
    // Userinfo cannot smuggle a different authority either.
    expect(normalizeLocalHttpEndpoint("http://127.0.0.1@evil.com", FALLBACK)).toBeUndefined()
  })

  test("rejects non-http schemes, credentials, query, and fragments", () => {
    expect(normalizeLocalHttpEndpoint("local://claude-code", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("file:///etc/passwd", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("ftp://127.0.0.1", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("http://user@127.0.0.1", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("http://127.0.0.1?key=x", FALLBACK)).toBeUndefined()
    expect(normalizeLocalHttpEndpoint("http://127.0.0.1#frag", FALLBACK)).toBeUndefined()
  })

  test("keeps non-v1 path prefixes and trims trailing slashes", () => {
    expect(normalizeLocalHttpEndpoint("http://127.0.0.1:8080/proxy/", FALLBACK)).toBe(
      "http://127.0.0.1:8080/proxy",
    )
  })
})
