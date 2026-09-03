import { isIP } from "node:net"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchText, HttpError } from "../../util/http"

const ENDPOINT = "https://check.torproject.org"
const PATH = "/torbulkexitlist"
const CACHE_TTL_MS = 10 * 60_000

export function parseTorExitList(value: string) {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
  const unique = new Set(entries.map((entry) => entry.toLowerCase()))
  if (unique.size < 100 || entries.some((entry) => isIP(entry) !== 4)) {
    throw new ToolError("Tor exit feed had an unexpected shape; refusing a potentially incomplete classification")
  }
  return unique
}

async function exits(ctx: IntegrationContext) {
  try {
    return parseTorExitList(
      await fetchText(`${ENDPOINT}${PATH}`, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: "tor-exit-list" },
        fixedEndpoint: { id: "tor-exit", endpoint: ENDPOINT, pathPrefix: PATH },
        maxResponseBytes: 1024 * 1024,
      }),
    )
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`Tor exit feed download failed${status}; retry later`)
  }
}

export const TorExit: Integration = {
  id: "tor-exit",
  category: "data",
  description: "Classify IPv4 addresses against Tor's official near-real-time exit list",
  tools: [
    {
      name: "tor_exit_lookup",
      description:
        "Check whether an IP is currently in Tor's official exit list. Tor usage is an anonymity signal, not malicious reputation.",
      inputSchema: {
        type: "object",
        properties: { ip: { type: "string", description: "Exact IPv4 address" } },
        required: ["ip"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        if (typeof args.ip !== "string" || isIP(args.ip.trim()) !== 4) {
          throw new ToolError('"ip" must be a valid IPv4 address; the official bulk list does not cover IPv6')
        }
        const ip = args.ip.trim().toLowerCase()
        return {
          source: "Tor Project exit list",
          license: "CC0-1.0",
          ip,
          isExit: (await exits(ctx)).has(ip),
          caution:
            "Tor exit status is not evidence of maliciousness; use it for context, rate limits, or step-up verification rather than attribution or blocking alone.",
        }
      },
    },
  ],
}
