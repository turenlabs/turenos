import { describe, expect, test } from "bun:test"
import { providerAuthTagKey } from "./provider-auth-tag"

describe("providerAuthTagKey", () => {
  test("distinguishes OpenAI subscriptions from API keys", () => {
    expect(providerAuthTagKey({ id: "openai", source: "api", auth: "oauth" })).toBe(
      "settings.providers.tag.subscription",
    )
    expect(providerAuthTagKey({ id: "openai", source: "api", auth: "api" })).toBeUndefined()
    expect(providerAuthTagKey({ id: "openai", source: "env", auth: "oauth" })).toBe(
      "settings.providers.tag.subscription",
    )
  })

  test("labels other OAuth provider connections without calling them subscriptions", () => {
    expect(providerAuthTagKey({ id: "xai", source: "api", auth: "oauth" })).toBe("settings.providers.tag.oauth")
    expect(providerAuthTagKey({ id: "opencode", source: "api", auth: "wellknown" })).toBe(
      "settings.providers.tag.account",
    )
  })
})
