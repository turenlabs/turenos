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
