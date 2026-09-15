import type { TranslationKey } from "@/context/language"

export const popularProviders = [
  "anthropic",
  "claude-code",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

// Providers withheld from every model and provider list. OpenCode Zen is retired;
// OpenCode Go is still published by models.dev, so it is offered like any other catalog provider.
const removedProviders = new Set<string>(["opencode"])

export function isRemovedProvider(id: string) {
  return removedProviders.has(id)
}

// Local runtimes that get their own settings area instead of appearing under Cloud Providers.
// Anything else that terminates on loopback (custom endpoints, lmstudio) is classified local too.
const localProviderIDs = new Set(["claude-code", "muse-code", "ollama", "llama-cpp"])

export type LocalProviderMeta = {
  id: string
  name: string
  kind: "cli" | "server"
  endpoint?: string
  descriptionKey: TranslationKey
}

export const localProviders: LocalProviderMeta[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    descriptionKey: "settings.localProviders.available.claudeCode",
  },
  {
    id: "muse-code",
    name: "Muse Code",
    kind: "cli",
    descriptionKey: "settings.localProviders.available.museCode",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "server",
    endpoint: "http://127.0.0.1:11434",
    descriptionKey: "settings.localProviders.available.ollama",
  },
  {
    id: "llama-cpp",
    name: "llama.cpp",
    kind: "server",
    endpoint: "http://127.0.0.1:8080",
    descriptionKey: "settings.localProviders.available.llamaCpp",
  },
]

export function isLocalProvider(provider: { id: string; options?: Record<string, unknown> }) {
  if (localProviderIDs.has(provider.id)) return true
  return isLocalProviderEndpoint(provider.options?.baseURL)
}

// A provider dropped from the catalog (disabled, or its server is down) can still be classified
// from the endpoint stored in its `provider.<id>` config entry.
export function isLocalProviderID(id: string, configBaseURL?: unknown) {
  if (localProviderIDs.has(id)) return true
  return isLocalProviderEndpoint(configBaseURL)
}

export function isLocalProviderEndpoint(value: unknown) {
  if (typeof value !== "string" || !value) return false
  if (value.startsWith("local://")) return true
  try {
    // Match the core normalizer: schemeless host:port input defaults to http.
    const candidate = value.includes("://") ? value : `http://${value}`
    const host = new URL(candidate).hostname.replace(/^\[|\]$/g, "").toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}
