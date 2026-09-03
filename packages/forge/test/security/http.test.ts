import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { classifyAddress } from "../../src/util/ip-address"
import { parseDropAsns, parseDropNetworks } from "../../src/security/integrations/data-ioc/spamhaus-drop"
import { parseSslblCertificates, parseSslblIps } from "../../src/security/integrations/data-ioc/sslbl"
import { fetchText } from "../../src/security/util/http"

describe("security data HTTP", () => {
  test("rejects oversized decoded responses", async () => {
    await expect(fetchText("data:text/plain,abcdef", { attempts: 1, maxResponseBytes: 3 })).rejects.toThrow(
      "response exceeded 3 bytes",
    )
  })

  test("rejects fixed endpoints that resolve outside the public network", async () => {
    await expect(
      fetchText("http://127.0.0.1/feed", {
        attempts: 1,
        fixedEndpoint: { id: "test", endpoint: "http://127.0.0.1", pathPrefix: "/feed" },
      }),
    ).rejects.toThrow()
  })

  test("classifies deprecated IPv6 site-local addresses as private", () => {
    expect(classifyAddress("fec0::1")).toBe("lan")
    expect(classifyAddress("feff::1")).toBe("lan")
  })

  test("rejects malformed threat feeds instead of returning false negatives", () => {
    expect(() => parseDropNetworks("<html>temporary error</html>")).toThrow("no valid entries")
    expect(() => parseDropAsns("<html>temporary error</html>")).toThrow("no valid entries")
    expect(() => parseSslblCertificates("<html>temporary error</html>")).toThrow("no valid entries")
    expect(() => parseSslblIps("<html>temporary error</html>")).toThrow("no valid entries")
  })

  test("coalesces concurrent cold-cache requests", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        requests += 1
        await Bun.sleep(25)
        return new Response("feed")
      },
    })
    const directory = await mkdtemp(path.join(tmpdir(), "turen-security-http-"))
    try {
      const url = `${server.url}feed`
      const options = { cache: { dir: directory, ttlMs: 60_000 } }
      expect(await Promise.all([fetchText(url, options), fetchText(url, options), fetchText(url, options)])).toEqual([
        "feed",
        "feed",
        "feed",
      ])
      expect(requests).toBe(1)
    } finally {
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
