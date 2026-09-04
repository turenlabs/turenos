export function providerAuthTagKey(item: { id: string; source?: string; auth?: string }) {
  if (item.auth === "wellknown") return "settings.providers.tag.account"
  if (item.auth !== "oauth") return
  return item.id === "openai" ? "settings.providers.tag.subscription" : "settings.providers.tag.oauth"
}
