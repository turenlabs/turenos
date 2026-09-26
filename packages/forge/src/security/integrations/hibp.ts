import { ExtensionCatalog } from "@turenlabs/extensions"
import crypto from "node:crypto"
import type { Integration } from "../registry"
import { ToolError, type IntegrationContext } from "../types"
import { fetchJson, fetchText, HttpError } from "../util/http"

/**
 * Have I Been Pwned (HIBP).
 *
 * Two keyless surfaces only:
 * - Pwned Passwords k-anonymity range API (api.pwnedpasswords.com/range/{prefix}):
 *   the SHA-1 is computed locally and only its first 5 hex chars ever leave the
 *   machine; the suffix is matched locally. The input password/hash is never
 *   included in results or logs.
 * - Free breach metadata (haveibeenpwned.com/api/v3/breaches, /breach/{name}).
 *
 * Per-email account search is a paid API and is intentionally not implemented.
 */

const SOURCE = "Have I Been Pwned (CC-BY 4.0, haveibeenpwned.com)"
const RANGE_API = ExtensionCatalog.dataEndpoint("security:hibp", "passwords")
const BREACH_API = ExtensionCatalog.dataEndpoint("security:hibp", "breaches")
/** Per-query API cache TTL (~1h, per docs/development/security-integrations.md). */
const QUERY_TTL_MS = 3_600_000
/** Cap breach lists so results stay well under the 50KB serialization limit. */
const MAX_BREACHES = 50

const SHA1_RE = /^[0-9a-f]{40}$/i
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i

/** Upstream breach model (subset; see haveibeenpwned.com/API/v3). */
interface BreachResponse {
  Name?: string
  Title?: string
  Domain?: string
  BreachDate?: string
  PwnCount?: number
  DataClasses?: string[]
  IsVerified?: boolean
  IsFabricated?: boolean
  IsSensitive?: boolean
  IsMalware?: boolean
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function summarizeBreach(breach: BreachResponse) {
  return {
    name: breach.Name,
    title: breach.Title,
    domain: breach.Domain || undefined,
    breachDate: breach.BreachDate,
    pwnCount: breach.PwnCount,
    dataClasses: breach.DataClasses,
    verified: breach.IsVerified,
    ...(breach.IsFabricated ? { fabricated: true } : {}),
    ...(breach.IsSensitive ? { sensitive: true } : {}),
    ...(breach.IsMalware ? { malware: true } : {}),
  }
}

async function passwordPwned(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const password = args["password"]
  const sha1 = optionalString(args, "sha1")
  if (password !== undefined && typeof password !== "string") throw new ToolError(`"password" must be a string`)
  const hasPassword = typeof password === "string" && password.length > 0

  if (hasPassword === (sha1 !== undefined)) {
    throw new ToolError(`provide exactly one of "password" (plaintext) or "sha1" (40-char hex SHA-1 digest)`)
  }

  let digest: string
  if (hasPassword) {
    // SHA-1 is mandated by the HIBP Pwned Passwords k-anonymity protocol; it is
    // used as a lookup key against a breach corpus, not for our own security.
    digest = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase()
  } else {
    if (!SHA1_RE.test(sha1!)) throw new ToolError(`"sha1" must be a 40-character hex SHA-1 digest`)
    digest = sha1!.toUpperCase()
  }

  // k-anonymity: only the first 5 hex chars of the digest are sent upstream.
  const prefix = digest.slice(0, 5)
  const suffix = digest.slice(5)

  let body: string
  try {
    body = await fetchText(`${RANGE_API}/${prefix}`, { cache: { dir: ctx.cacheDir, ttlMs: QUERY_TTL_MS } })
  } catch (error) {
    if (error instanceof HttpError) {
      throw new ToolError(`Pwned Passwords range query failed (HTTP ${error.status}); retry later`)
    }
    throw new ToolError(`Pwned Passwords range query failed; check network connectivity and retry`)
  }

  // Response lines are "SUFFIX:COUNT"; match the remaining 35 chars locally.
  let count = 0
  for (const line of body.split(/\r?\n/)) {
    const sep = line.indexOf(":")
    if (sep <= 0) continue
    if (line.slice(0, sep).toUpperCase() !== suffix) continue
    const parsed = Number.parseInt(line.slice(sep + 1).trim(), 10)
    count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    break
  }

  // Never echo the password, hash, or even the prefix back in the result.
  return { pwned: count > 0, count, source: SOURCE }
}

async function breachLookup(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const name = optionalString(args, "name")
  const domain = optionalString(args, "domain")
  if (name === undefined && domain === undefined) {
    throw new ToolError(`provide "name" (breach name, e.g. "Adobe") or "domain" (e.g. "adobe.com")`)
  }
  if (name !== undefined && domain !== undefined) {
    throw new ToolError(`provide only one of "name" or "domain"`)
  }

  const cache = { dir: ctx.cacheDir, ttlMs: QUERY_TTL_MS }

  if (name !== undefined) {
    let breach: BreachResponse
    try {
      breach = await fetchJson<BreachResponse>(`${BREACH_API}/breach/${encodeURIComponent(name)}`, { cache })
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new ToolError(
          `no breach named "${name}" in Have I Been Pwned; check the spelling or search by "domain" instead`,
        )
      }
      if (error instanceof HttpError)
        throw new ToolError(`Have I Been Pwned breach lookup failed (HTTP ${error.status}); retry later`)
      throw new ToolError(`Have I Been Pwned breach lookup failed; check network connectivity and retry`)
    }
    return { total: 1, breaches: [summarizeBreach(breach)], source: SOURCE }
  }

  if (!DOMAIN_RE.test(domain!)) throw new ToolError(`"domain" must be a bare domain name, e.g. "adobe.com"`)

  let breaches: BreachResponse[]
  try {
    breaches = await fetchJson<BreachResponse[]>(`${BREACH_API}/breaches?Domain=${encodeURIComponent(domain!)}`, {
      cache,
    })
  } catch (error) {
    if (error instanceof HttpError)
      throw new ToolError(`Have I Been Pwned breach lookup failed (HTTP ${error.status}); retry later`)
    throw new ToolError(`Have I Been Pwned breach lookup failed; check network connectivity and retry`)
  }
  if (!Array.isArray(breaches)) throw new ToolError(`unexpected response from Have I Been Pwned; retry later`)

  const sorted = [...breaches].sort((a, b) => (b.PwnCount ?? 0) - (a.PwnCount ?? 0))
  const top = sorted.slice(0, MAX_BREACHES).map(summarizeBreach)
  return { total: breaches.length, returned: top.length, breaches: top, source: SOURCE }
}

export const Hibp: Integration = {
  id: "hibp",
  category: "data",
  description:
    "Check passwords via the k-anonymity Pwned Passwords API and look up breach metadata from Have I Been Pwned",
  tools: [
    {
      name: "hibp_password_pwned",
      description:
        "Check whether a password appears in known breach corpuses via the Have I Been Pwned k-anonymity range API. " +
        "The SHA-1 is computed locally and only its first 5 hex characters are sent upstream; the password never leaves the machine and is never included in the result.",
      inputSchema: {
        type: "object",
        properties: {
          password: {
            type: "string",
            description: "Plaintext password to check (processed locally, never sent upstream)",
          },
          sha1: { type: "string", description: "Alternatively, the full 40-char hex SHA-1 digest of the password" },
        },
        additionalProperties: false,
      },
      handler: passwordPwned,
    },
    {
      name: "hibp_breach_lookup",
      description:
        'Look up Have I Been Pwned breach metadata by breach name (e.g. "Adobe") or by breached domain (e.g. "adobe.com"). ' +
        "Returns breach summaries (date, pwn count, exposed data classes). Per-email account search is a paid API and is not available.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: 'Breach name to look up, e.g. "Adobe"' },
          domain: { type: "string", description: 'Domain whose breaches to list, e.g. "adobe.com"' },
        },
        additionalProperties: false,
      },
      handler: breachLookup,
    },
  ],
}
