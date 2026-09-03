import { afterEach, describe, expect, test } from "bun:test"
import { gunzipSync, inflateSync } from "node:zlib"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default().app
}

// /config echoes the config back. Padding a valid permission map pushes the
// response body well past the 1024 B threshold so we can observe compression.
function fatConfig() {
  const permission = Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [`compression-padding-${index}`, "allow" as const]),
  )
  return {
    formatter: false,
    lsp: false,
    username: "compression-test-user",
    permission,
  }
}

describe("HttpApi compression", () => {
  describe("encodes responses", () => {
    test("gzips JSON when Accept-Encoding includes gzip and body exceeds threshold", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("gzip")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = gunzipSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
      expect(compressed.byteLength).toBeLessThan(decompressed.byteLength)
    })

    test("uses deflate when only deflate is acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "deflate" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("deflate")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = inflateSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
    })

    test("prefers gzip when both gzip and deflate are acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "gzip, deflate" },
      })
      expect(response.headers.get("content-encoding")).toBe("gzip")
    })

    test("does not include the original Content-Length when compressed", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "gzip" },
      })
      const compressed = new Uint8Array(await response.arrayBuffer())
      const declared = response.headers.get("content-length")
      // Either absent (transfer-encoding chunked) or matches the compressed length.
      if (declared !== null) expect(Number(declared)).toBe(compressed.byteLength)
    })
  })

  describe("skips", () => {
    test("when no Accept-Encoding header is present", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when Accept-Encoding only allows unsupported encodings", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "br" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when the response body is below the 1024-byte threshold", async () => {
      // A bare config produces a tiny response (~few hundred bytes).
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const response = await app().request("/config", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body.byteLength).toBeLessThan(1024)
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("HEAD requests", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        method: "HEAD",
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })
  })

  describe("streaming exclusions", () => {
    test("/event SSE is not compressed", async () => {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const controller = new AbortController()
      const response = await app().request("/event", {
        headers: { "x-forge-directory": tmp.path, "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
        expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })

    test("/global/event SSE is not compressed", async () => {
      const controller = new AbortController()
      const response = await app().request("/global/event", {
        headers: { "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
        expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })
  })
})
