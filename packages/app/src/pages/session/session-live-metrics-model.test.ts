import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ProviderUsageResponse } from "@turenlabs/sdk/v2/client"
import { cacheHitRate, providerQuota } from "./session-live-metrics-model"

const assistant = (tokens: { input: number; output?: number; read?: number; write?: number }) =>
  ({
    role: "assistant",
    tokens: {
      input: tokens.input,
      output: tokens.output ?? 0,
      reasoning: 0,
      cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
    },
  }) as AssistantMessage

const quotas = (
  providerID: string,
  status: "available" | "unavailable" | "error",
  windows: Array<{ label: string; usedPercent: number; reset?: string }>,
): ProviderUsageResponse["quotas"] => [{ providerID, status, source: "provider", windows }]

describe("cacheHitRate", () => {
  test("returns the share of the prompt served from cache", () => {
    expect(cacheHitRate(assistant({ input: 20, read: 80 }))).toBe(80)
    expect(cacheHitRate(assistant({ input: 50, read: 25, write: 25 }))).toBe(25)
  })

  test("is undefined without a message or any prompt tokens", () => {
    expect(cacheHitRate(undefined)).toBeUndefined()
    expect(cacheHitRate(assistant({ input: 0 }))).toBeUndefined()
  })

  test("is 0 when nothing was cached, not hidden", () => {
    expect(cacheHitRate(assistant({ input: 100 }))).toBe(0)
  })
})

describe("providerQuota", () => {
  test("returns the fullest reported window", () => {
    const result = providerQuota(
      quotas("openai", "available", [
        { label: "5h", usedPercent: 40 },
        { label: "weekly", usedPercent: 61, reset: "in 3 days" },
      ]),
      "openai",
    )
    expect(result?.usedPercent).toBe(61)
    expect(result?.windows).toHaveLength(2)
  })

  test("is hidden when the provider reports no quota or only empty windows", () => {
    expect(providerQuota(quotas("anthropic", "available", []), "anthropic")).toBeUndefined()
    expect(providerQuota(undefined, "openai")).toBeUndefined()
    expect(providerQuota(quotas("openai", "available", [{ label: "5h", usedPercent: 10 }]), "other")).toBeUndefined()
  })

  test("is hidden for non-available quota entries so errors never look like real limits", () => {
    expect(
      providerQuota(quotas("openai", "error", [{ label: "5h", usedPercent: 90 }]), "openai"),
    ).toBeUndefined()
  })
})
