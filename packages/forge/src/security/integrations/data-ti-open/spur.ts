import { ExtensionCatalog } from "@turenlabs/extensions"
import { isIP } from "node:net"
import type { Integration } from "../../registry"
import { ToolError } from "../../types"
import { fetchJson, HttpError } from "../../util/http"
import { classifyAddress } from "@/util/ip-address"

/**
 * Spur Context API (bring-your-own subscription token).
 * API: GET https://api.spur.us/v2/context/{ip} with header `Token: <SPUR_TOKEN>`.
 *
 * Every uncached lookup consumes paid quota and discloses the queried IP to
 * Spur, so only public IPs are sent, responses are cached, and quota
 * exhaustion (HTTP 429) is never retried.
 */

const ENDPOINT = ExtensionCatalog.dataEndpoint("security:spur")
const PATH = "/v2/context/"
const CACHE_TTL_MS = 3_600_000

export function requirePublicIp(value: unknown) {
  const ip = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!isIP(ip)) throw new ToolError('"ip" must be a single IPv4 or IPv6 address')
  if (classifyAddress(ip) !== "public") {
    throw new ToolError(`"${ip}" is not a public address; Spur only has context for public IPs`)
  }
  return ip
}

export function spurError(error: unknown) {
  if (error instanceof ToolError) return error
  if (!(error instanceof HttpError)) return new ToolError("Spur lookup failed; check network connectivity and retry")
  if (error.status === 401)
    return new ToolError("Spur rejected the API token (HTTP 401); update it on the Spur data source")
  if (error.status === 403) return new ToolError("The Spur token does not include Context API access (HTTP 403)")
  if (error.status === 429) return new ToolError("The Spur subscription has no remaining queries this cycle (HTTP 429)")
  if (error.status === 400) return new ToolError("Spur rejected the address; it must be a public IPv4 or IPv6 address")
  return new ToolError(`Spur lookup failed (HTTP ${error.status}); retry later`)
}

export const Spur: Integration = {
  id: "spur",
  category: "data",
  description: "Enrich IP addresses with Spur's VPN, residential proxy, and anonymization context",
  tools: [
    {
      name: "spur_ip_context",
      description:
        "Look up Spur IP context for one public IP: infrastructure type, VPN/proxy/tunnel operators, observed client behaviors, risks, ASN, and location. " +
        "Consumes one query from the user's Spur subscription and sends the IP to Spur. Anonymity labels are context, not maliciousness.",
      inputSchema: {
        type: "object",
        properties: { ip: { type: "string", description: "Exact public IPv4 or IPv6 address" } },
        required: ["ip"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const ip = requirePublicIp(args.ip)
        const token = ctx.secrets.SPUR_TOKEN
        if (!token) throw new ToolError("Add a Spur Context API token on the Spur data source to use this tool")
        const context = await fetchJson<Record<string, unknown>>(`${ENDPOINT}${PATH}${encodeURIComponent(ip)}`, {
          headers: { Token: token },
          // Spur's 429 means the paid quota is exhausted; retries only burn time.
          attempts: 1,
          maxResponseBytes: 256 * 1024,
          // The default key hashes the URL and Token header, keeping the cache per-token without writing either to disk.
          cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
          fixedEndpoint: { id: "spur", endpoint: ENDPOINT, pathPrefix: PATH },
        }).catch((error: unknown) => {
          throw spurError(error)
        })
        if (!context || typeof context !== "object" || Array.isArray(context)) {
          throw new ToolError("Spur returned an unexpected response; retry later")
        }
        return {
          source: "Spur Context API",
          ip,
          context,
          caution:
            "VPN, proxy, and tunnel labels describe anonymization, not malicious intent; use them for context, rate limits, or step-up verification rather than attribution or blocking alone.",
        }
      },
    },
  ],
}
