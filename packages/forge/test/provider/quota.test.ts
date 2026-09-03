import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ProviderQuota } from "@/provider/quota"

describe("provider quota", () => {
  test("normalizes OpenAI Codex windows", () => {
    expect(
      ProviderQuota.parseOpenAI(ProviderV2.ID.openai, {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 24.5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 1_800_100_000 },
        },
      }) as unknown,
    ).toEqual({
      providerID: "openai",
      status: "available",
      source: "provider",
      plan: "pro",
      windows: [
        { label: "5-hour window", usedPercent: 24.5, windowMinutes: 300, resetAt: 1_800_000_000_000 },
        { label: "Weekly window", usedPercent: 60, windowMinutes: 10_080, resetAt: 1_800_100_000_000 },
      ],
    })
  })

  test("normalizes Kimi summary and rolling limits", () => {
    expect(
      ProviderQuota.parseKimi(ProviderV2.ID.make("kimi-for-coding"), {
        usage: { limit: 1_000, used: 250, resetAt: "2027-01-15T00:00:00Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "MINUTE" },
            detail: { limit: 100, remaining: 40 },
          },
        ],
      }) as unknown,
    ).toEqual({
      providerID: "kimi-for-coding",
      status: "available",
      source: "provider",
      windows: [
        { label: "Weekly limit", usedPercent: 25, resetAt: Date.parse("2027-01-15T00:00:00Z") },
        { label: "5-hour limit", usedPercent: 60 },
      ],
    })
  })

  test("normalizes Claude Code local usage output", () => {
    expect(
      ProviderQuota.parseClaude(
        ProviderV2.ID.make("claude-code"),
        JSON.stringify({
          result: [
            "You are currently using your subscription to power your Claude Code usage",
            "",
            "Current session: 4% used",
            "Current week (all models): 81% used \u00b7 resets Aug 2 at 8pm (America/Chicago)",
          ].join("\n"),
        }),
      ) as unknown,
    ).toEqual({
      providerID: "claude-code",
      status: "available",
      source: "cli",
      plan: "Subscription",
      windows: [
        { label: "session", usedPercent: 4, reset: undefined },
        { label: "week (all models)", usedPercent: 81, reset: "Aug 2 at 8pm (America/Chicago)" },
      ],
    })
  })

  test("does not invent Kimi usage or emit invalid reset values", () => {
    expect(ProviderQuota.parseKimi(ProviderV2.ID.make("kimi-for-coding"), { usage: { limit: 100 } }).status).toBe(
      "error",
    )
    expect(
      ProviderQuota.parseOpenAI(ProviderV2.ID.openai, {
        rate_limit: { primary_window: { used_percent: 10, reset_at: -1, limit_window_seconds: -60 } },
      }).windows,
    ).toEqual([{ label: "Rate limit", usedPercent: 10 }])
  })

  test("labels an OpenAI primary window from its actual duration", () => {
    expect(
      ProviderQuota.parseOpenAI(ProviderV2.ID.openai, {
        rate_limit: {
          primary_window: { used_percent: 83, limit_window_seconds: 604_800, reset_at: 1_800_000_000 },
        },
      }).windows[0]?.label,
    ).toBe("Weekly window")
  })
})
