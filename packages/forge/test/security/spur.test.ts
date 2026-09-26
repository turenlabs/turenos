import { describe, expect, test } from "bun:test"
import { ToolError } from "../../src/security/types"
import { HttpError } from "../../src/security/util/http"
import { SecurityRegistry } from "../../src/security/registry"
import { requirePublicIp, spurError } from "../../src/security/integrations/data-ti-open/spur"

const spur = SecurityRegistry.integration("spur")!
const lookup = (args: Record<string, unknown>, secrets: Record<string, string> = {}) =>
  spur.tools[0]!.handler(
    args,
    { workspace: "/", cacheDir: "/nonexistent", secrets },
    { signal: new AbortController().signal, progress: async () => {} },
  )

describe("spur data source", () => {
  test("is wired as a data integration that requires a stored token", () => {
    expect(spur.category).toBe("data")
    expect(spur.secrets).toEqual(["SPUR_TOKEN"])
    expect(spur.tools.map((tool) => tool.name)).toEqual(["spur_ip_context"])
    expect(
      SecurityRegistry.makeContext(spur, { FORGE_SECURITY_SPUR_TOKEN: "tok", FORGE_SECURITY_NVD_KEY: "other" }).secrets,
    ).toEqual({ SPUR_TOKEN: "tok" })
  })

  test("only sends single public IPs upstream", () => {
    expect(requirePublicIp(" 89.39.106.191 ")).toBe("89.39.106.191")
    expect(requirePublicIp("2606:4700:4700::1111")).toBe("2606:4700:4700::1111")
    for (const input of ["10.0.0.1", "127.0.0.1", "::1", "169.254.169.254", "fd00::1", "192.0.2.1"]) {
      expect(() => requirePublicIp(input)).toThrow("not a public address")
    }
    for (const input of ["example.com", "1.1.1.1/../x", "1.1.1.1?dt=20260101", "", 42, undefined]) {
      expect(() => requirePublicIp(input)).toThrow("must be a single IPv4 or IPv6 address")
    }
  })

  test("rejects lookups before any request when inputs or token are missing", async () => {
    await expect(lookup({ ip: "1.1.1.1" })).rejects.toThrow("Add a Spur Context API token")
    await expect(lookup({ ip: "10.0.0.1" }, { SPUR_TOKEN: "tok" })).rejects.toThrow("not a public address")
  })

  test("maps Spur status codes to actionable errors without echoing the token", () => {
    const message = (status: number) =>
      spurError(new HttpError("https://api.spur.us/v2/context/1.1.1.1", status)).message
    expect(message(401)).toContain("rejected the API token")
    expect(message(403)).toContain("Context API access")
    expect(message(429)).toContain("no remaining queries")
    expect(message(500)).toContain("HTTP 500")
    expect(spurError(new Error("boom"))).toBeInstanceOf(ToolError)
  })
})
