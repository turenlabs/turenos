import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import tls from "node:tls"
import { McpCaBundle } from "../../src/mcp/ca-bundle"

const supported = typeof tls.getCACertificates === "function"

describe("MCP CA bundle environment", () => {
  test("fills CA bundle vars the child has not set", () => {
    const environment = McpCaBundle.environment({ PATH: "/bin" })
    if (!supported) {
      expect(environment).toEqual({ PATH: "/bin" })
      return
    }
    const file = environment.SSL_CERT_FILE!
    expect(file).toEndWith("ca-bundle.pem")
    expect(environment.REQUESTS_CA_BUNDLE).toBe(file)
    expect(environment.CURL_CA_BUNDLE).toBe(file)
    expect(environment.GIT_SSL_CAINFO).toBe(file)
    expect(environment.NODE_EXTRA_CA_CERTS).toBe(file)
    expect(environment.UV_NATIVE_TLS).toBe("1")
    expect(fs.readFileSync(file, "utf8")).toContain("BEGIN CERTIFICATE")
  })

  test("preserves operator-provided CA configuration", () => {
    const environment = McpCaBundle.environment({
      SSL_CERT_FILE: "/custom/corporate.pem",
      UV_NATIVE_TLS: "0",
    })
    expect(environment.SSL_CERT_FILE).toBe("/custom/corporate.pem")
    expect(environment.UV_NATIVE_TLS).toBe("0")
  })
})
