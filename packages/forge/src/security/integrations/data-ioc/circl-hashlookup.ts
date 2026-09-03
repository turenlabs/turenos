import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const ENDPOINT = "https://hashlookup.circl.lu"
const SOURCE = "CIRCL hashlookup (CC BY 4.0, hashlookup.circl.lu)"
const CACHE_TTL_MS = 3_600_000
const HEX_RE = /^[0-9a-f]+$/i
const MAX_TEXT_CHARS = 240

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (text === "") return undefined
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text
}

function pick(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = bounded(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function fileSize(record: Record<string, unknown>): number | undefined {
  const value = record.FileSize ?? record.filesize ?? record.file_size
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined
  return parsed
}

function requireHash(value: unknown) {
  if (typeof value !== "string") {
    throw new ToolError('"hash" must be an MD5, SHA-1, or SHA-256 hexadecimal digest')
  }
  const hash = value.trim().toLowerCase()
  if (!HEX_RE.test(hash) || ![32, 40, 64].includes(hash.length)) {
    throw new ToolError('"hash" must be a 32-character MD5, 40-character SHA-1, or 64-character SHA-256 digest')
  }
  return { hash, algorithm: hash.length === 32 ? "md5" : hash.length === 40 ? "sha1" : "sha256" }
}

async function lookup(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const query = requireHash(args.hash)
  const request = {
    cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
    maxResponseBytes: 256_000,
    fixedEndpoint: { id: "circl-hashlookup", endpoint: ENDPOINT, pathPrefix: "/lookup" },
  }
  let response: unknown
  try {
    response = await fetchJson(`${ENDPOINT}/lookup/${query.algorithm}/${query.hash}`, request)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { source: SOURCE, hash: query.hash, algorithm: query.algorithm.toUpperCase(), known: false }
    }
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`CIRCL hash lookup failed${status}; check network access and retry later`)
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new ToolError("CIRCL hashlookup returned an unexpected response; retry later")
  }
  const record = response as Record<string, unknown>
  return {
    source: SOURCE,
    hash: query.hash,
    algorithm: query.algorithm.toUpperCase(),
    known: true,
    file: {
      name: pick(record, "FileName", "filename", "file_name"),
      size: fileSize(record),
      hashes: {
        md5: pick(record, "MD5", "md5"),
        sha1: pick(record, "SHA-1", "SHA1", "sha1"),
        sha256: pick(record, "SHA-256", "SHA256", "sha256"),
      },
      ssdeep: pick(record, "SSDEEP", "ssdeep"),
      tlsh: pick(record, "TLSH", "tlsh"),
      firstSeen: pick(record, "insert-timestamp", "insert_timestamp", "first_seen"),
      corpus: pick(record, "source", "Source"),
    },
  }
}

export const CirclHashlookup: Integration = {
  id: "circl-hashlookup",
  category: "data",
  description: "Identify known files by MD5, SHA-1, or SHA-256 using CIRCL hashlookup",
  tools: [
    {
      name: "circl_hashlookup",
      description:
        "Look up an MD5, SHA-1, or SHA-256 digest in CIRCL's public hash corpora. Returns compact file metadata when known; no file content is uploaded.",
      inputSchema: {
        type: "object",
        properties: { hash: { type: "string", description: "MD5, SHA-1, or SHA-256 hexadecimal digest" } },
        required: ["hash"],
        additionalProperties: false,
      },
      handler: lookup,
    },
  ],
}
