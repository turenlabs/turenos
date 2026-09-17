import fs from "node:fs"
import path from "node:path"
import tls from "node:tls"
import { Global } from "@turenlabs/core/global"

// TLS-intercepting tools (EDR network inspection, MCP scanners, corporate
// proxies) install their root CA in the OS trust store. The forge process
// already trusts it (--use-system-ca / setDefaultCACertificates), but spawned
// MCP servers run an isolated environment and fall back to bundled CA stores
// that reject the interception. Materialize the combined trust store and hand
// children the env vars their runtimes honor.
const BUNDLE_VARS = [
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
] as const

export function environment(environment: Readonly<Record<string, string>>) {
  const result = { ...environment }
  const file = bundle()
  if (!file) return result
  for (const name of BUNDLE_VARS) {
    if (result[name] === undefined) result[name] = file
  }
  if (result.UV_NATIVE_TLS === undefined) result.UV_NATIVE_TLS = "1"
  return result
}

function bundle() {
  try {
    if (typeof tls.getCACertificates !== "function") return undefined
    const pem = [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]
      .map((cert) => cert.trimEnd() + "\n")
      .join("")
    if (!pem) return undefined
    const file = path.join(Global.Path.cache, "ca-bundle.pem")
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== pem) {
      fs.mkdirSync(Global.Path.cache, { recursive: true })
      fs.writeFileSync(file, pem)
    }
    return file
  } catch {
    return undefined
  }
}

export * as McpCaBundle from "./ca-bundle"
