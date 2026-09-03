export const popularProviders = [
  "opencode",
  "anthropic",
  "claude-code",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

// Providers withheld from every model and provider list. Empty today: OpenCode Go is still
// published by models.dev, so it is offered like any other catalog provider.
const removedProviders = new Set<string>()

export function isRemovedProvider(id: string) {
  return removedProviders.has(id)
}
