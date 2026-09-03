export * as ConfigMcpLegacyV1 from "./mcp-legacy"

import { ExtensionCatalog } from "@turenlabs/extensions"

/**
 * The retired root config key that MCP servers used to be declared under.
 *
 * MCP moved to the extension catalog, so `ConfigV1.Info` no longer declares this key. That alone
 * would be harmless -- Effect Schema ignores excess properties -- but `ConfigParse.schema` runs a
 * hand-rolled unrecognized-key guard first (packages/forge/src/config/parse.ts:44), which turns any
 * undeclared root key into a fatal `ConfigInvalidError`. An upgraded user whose config still
 * carried `mcp` therefore lost *every* project, not just their MCP servers, with an error that
 * never named the key. This module is what lets that document keep loading.
 */
export const KEY = "mcp"

/** Where MCP servers live now. Appended to every warning so the message is actionable. */
export const RELOCATED = "MCP servers are now Extensions - open Settings > Extensions to add them"

/** A legacy entry that maps onto a catalog extension, which the migration activates. */
export interface Enable {
  readonly kind: "enable"
  readonly name: string
  /** Catalog manifest id, e.g. `turenlabs/notion`. */
  readonly extension: string
  readonly detail: string
}

/** A legacy entry whose replacement ships as part of the product and must not be recreated. */
export interface Obsolete {
  readonly kind: "obsolete"
  readonly name: string
  readonly detail: string
}

/** A legacy entry with no equivalent in the catalog. Warned about, never dropped silently. */
export interface Unmapped {
  readonly kind: "unmapped"
  readonly name: string
  readonly detail: string
}

/** A legacy entry the user had switched off. Recorded so the migration never re-enables it. */
export interface Disabled {
  readonly kind: "disabled"
  readonly name: string
  readonly detail: string
}

export type Entry = Enable | Obsolete | Unmapped | Disabled

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Splits the retired `mcp` key off a parsed config document without mutating it.
 *
 * `servers` is defined whenever the key was present, even when its value is malformed, so a caller
 * can still warn. Everything else is returned untouched: this is the only reason the rest of the
 * document survives the unrecognized-key guard.
 */
export function split(input: unknown): { readonly config: unknown; readonly servers?: Record<string, unknown> } {
  if (!isRecord(input) || !(KEY in input)) return { config: input }
  const { [KEY]: servers, ...config } = input
  return { config, servers: isRecord(servers) ? servers : {} }
}

/** `https://Mcp.Notion.com/mcp/` and `https://mcp.notion.com/mcp` are the same server. */
function normalizeUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase()
  } catch {
    return undefined
  }
}

/** Hosted MCP deployment URL -> catalog manifest id, built once from the compiled manifests. */
const hostedByUrl = new Map<string, string>()
for (const manifest of ExtensionCatalog.manifests) {
  for (const contribution of manifest.contributions) {
    if (contribution.type !== "mcp" || contribution.deployment.type !== "hosted") continue
    const url = normalizeUrl(contribution.deployment.url)
    if (url) hostedByUrl.set(url, manifest.id)
  }
}

/** The final argv entry of the bundled security MCP server. Mirrors `McpReaper`'s predicate. */
const SECURITY_MCP_ARG = "security-mcp"

/**
 * Accepted executables for the bundled security server, matched against the end of an argv entry.
 * Kept in step with `FORGE_ENTRYPOINTS` in packages/forge/src/mcp/reaper.ts:28.
 */
const FORGE_ENTRYPOINTS = [
  "/forge-cli",
  "/forge-cli.exe",
  "/forge",
  "/forge.exe",
  "/packages/forge/src/index.ts",
  "/forge/dist/node/index.js",
]

const FORGE_BASENAMES = new Set(["forge", "forge.exe", "forge-cli", "forge-cli.exe"])

/**
 * True for the old bundled `forge-cli security-mcp` server, whose replacement is the security
 * extensions. "Ends with" rather than "contains" so an unrelated server that merely mentions forge
 * in an argument is not swallowed.
 */
export function isBundledSecurityServer(command: readonly unknown[]) {
  const argv = command.filter((item): item is string => typeof item === "string")
  if (argv.length !== command.length || argv.at(-1) !== SECURITY_MCP_ARG) return false
  return argv.slice(0, -1).some((token) => {
    const value = token.replaceAll("\\", "/")
    if (FORGE_BASENAMES.has(value)) return true
    return FORGE_ENTRYPOINTS.some((entrypoint) => value.endsWith(entrypoint))
  })
}

/** Classifies every server under a legacy `mcp` block. Order follows the authored key order. */
export function classify(servers: Record<string, unknown>): Entry[] {
  return Object.entries(servers).map(([name, value]) => entry(name, value))
}

function entry(name: string, value: unknown): Entry {
  if (!isRecord(value)) return { kind: "unmapped", name, detail: "the entry is not an MCP server definition" }
  if (value["enabled"] === false) return { kind: "disabled", name, detail: "the server was disabled" }

  if (value["type"] === "remote") {
    const url = typeof value["url"] === "string" ? value["url"] : undefined
    if (!url) return { kind: "unmapped", name, detail: "the remote entry has no url" }
    const normalized = normalizeUrl(url)
    const extension = normalized ? hostedByUrl.get(normalized) : undefined
    if (extension) return { kind: "enable", name, extension, detail: url }
    return { kind: "unmapped", name, detail: `no extension provides ${url}` }
  }

  if (value["type"] === "local") {
    const command = Array.isArray(value["command"]) ? value["command"] : []
    if (isBundledSecurityServer(command)) {
      return {
        kind: "obsolete",
        name,
        detail: "the bundled security server is now provided by the security extensions",
      }
    }
    const printed = command.filter((item): item is string => typeof item === "string").join(" ")
    return {
      kind: "unmapped",
      name,
      detail: printed ? `no extension provides \`${printed}\`` : "the local entry has no command",
    }
  }

  return { kind: "unmapped", name, detail: "the entry has no `type`" }
}

/**
 * Concatenated entries from several config documents, reduced to one per server name and kind.
 *
 * Config documents merge lowest priority first, so the last classification of a name wins, matching
 * how every other key resolves.
 */
export function dedupe(entries: readonly Entry[]): Entry[] {
  const byName = new Map<string, Entry>()
  for (const item of entries) byName.set(item.name, item)
  return [...byName.values()]
}

/** Human-readable, actionable lines for everything the migration could not carry over. */
export function warnings(entries: readonly Entry[]): string[] {
  return entries.flatMap((item) => {
    if (item.kind === "enable" || item.kind === "disabled") return []
    if (item.kind === "obsolete") {
      return [`Legacy \`${KEY}\` config: server "${item.name}" was not migrated because ${item.detail}.`]
    }
    return [`Legacy \`${KEY}\` config: server "${item.name}" was not migrated because ${item.detail}. ${RELOCATED}.`]
  })
}
