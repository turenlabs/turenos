import { describe, expect, test } from "bun:test"
import {
  cleanModelName,
  compactModelSearch,
  compareProviders,
  defaultModel,
  latestModels,
  matchesModelSearch,
  modelKey,
  modelVisible,
  normalizeModelSearch,
  popularProviders,
  pushRecent,
  sortModelGroups,
  withoutDeprecated,
} from "../src/models"

const DAY = 24 * 60 * 60 * 1000
// UTC timestamps keep the 180 day boundary exact in any timezone; date-only values are local midnight.
const now = Date.UTC(2026, 9, 8, 12)
const daysAgo = (days: number) => new Date(now - days * DAY).toISOString()
const model = (id: string, release_date?: string, family?: string, providerID = "p") => ({
  id,
  providerID,
  family,
  release_date,
})

describe("provider ordering", () => {
  const group = (category: string, name: string) => ({ category, items: [{ provider: { name } }] })

  test("popular providers come first in popularProviders order", () => {
    const sorted = sortModelGroups([group("openai", "OpenAI"), group("zed", "Zed"), group("anthropic", "Anthropic")])
    expect(sorted.map((item) => item.category)).toEqual(["anthropic", "openai", "zed"])
  })

  test("other providers sort alphabetically by name and the input is untouched", () => {
    const input = [group("b", "Beta"), group("c", "Charlie"), group("a", "alpha")]
    expect(sortModelGroups(input).map((item) => item.category)).toEqual(["a", "b", "c"])
    expect(input.map((item) => item.category)).toEqual(["b", "c", "a"])
  })

  test("compareProviders ranks popular before non-popular", () => {
    expect(compareProviders({ id: "vercel", name: "Vercel" }, { id: "aaa", name: "Aaa" })).toBeLessThan(0)
    expect(compareProviders({ id: "aaa", name: "Aaa" }, { id: "vercel", name: "Vercel" })).toBeGreaterThan(0)
    expect(compareProviders({ id: "google", name: "G" }, { id: "google", name: "G" })).toBe(0)
  })

  test("popular providers include claude-code and not the retired opencode", () => {
    expect(popularProviders).toContain("claude-code")
    expect(popularProviders).not.toContain("opencode")
  })
})

describe("model search", () => {
  test("normalizes separators and case", () => {
    expect(normalizeModelSearch("  GPT-5.5__Mini ")).toBe("gpt 5 5 mini")
    expect(compactModelSearch("GPT-5.5 Mini")).toBe("gpt55mini")
  })

  test("matches model names across separators", () => {
    expect(matchesModelSearch("gpt 5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt-5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt5", ["GPT-5.5"])).toBe(true)
  })

  test("matches any searchable model field", () => {
    expect(matchesModelSearch("open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
    expect(matchesModelSearch("gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
  })

  test("empty query matches everything and unrelated queries match nothing", () => {
    expect(matchesModelSearch("  ", ["x"])).toBe(true)
    expect(matchesModelSearch("claude", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(false)
  })
})

describe("cleanModelName", () => {
  test("strips the latest marker and flags it", () => {
    expect(cleanModelName("Sonnet (latest)")).toEqual({ name: "Sonnet", latest: true })
    expect(cleanModelName("Sonnet 5")).toEqual({ name: "Sonnet 5", latest: false })
  })
})

describe("latestModels", () => {
  test("includes the newest model per family inside the window", () => {
    const set = latestModels(
      [
        model("old", daysAgo(100), "sonnet"),
        model("new", daysAgo(10), "sonnet"),
        model("other", daysAgo(50), "haiku"),
      ],
      now,
    )
    expect([...set].sort()).toEqual(["p:new", "p:other"])
  })

  test("the window is exclusive at 180 days, in either direction", () => {
    expect(latestModels([model("a", daysAgo(179), "f")], now).has("p:a")).toBe(true)
    expect(latestModels([model("a", daysAgo(180), "f")], now).has("p:a")).toBe(false)
    expect(latestModels([model("a", daysAgo(181), "f")], now).has("p:a")).toBe(false)
    expect(latestModels([model("a", daysAgo(-179), "f")], now).has("p:a")).toBe(true)
    expect(latestModels([model("a", daysAgo(-180), "f")], now).has("p:a")).toBe(false)
  })

  test("a model outside the window does not shadow an older family member", () => {
    const set = latestModels([model("recent", daysAgo(30), "f"), model("ancient", daysAgo(400), "f")], now)
    expect([...set]).toEqual(["p:recent"])
  })

  test("groups by provider and family together", () => {
    const set = latestModels(
      [model("a", daysAgo(10), "f", "one"), model("a", daysAgo(20), "f", "two"), model("b", daysAgo(5), "g", "one")],
      now,
    )
    expect([...set].sort()).toEqual(["one:a", "one:b", "two:a"])
  })

  test("ties keep the first model and release dates compare as strings", () => {
    expect([...latestModels([model("a", daysAgo(10), "f"), model("b", daysAgo(10), "f")], now)]).toEqual(["p:a"])
    expect([...latestModels([model("a", "2026-09", "f"), model("b", "2026-09-02", "f")], now)]).toEqual(["p:b"])
  })

  test("ignores undated, invalid and family-less models", () => {
    const set = latestModels(
      [model("none", undefined, "f"), model("bad", "not-a-date", "f"), model("nofamily", daysAgo(1), undefined)],
      now,
    )
    expect(set.size).toBe(0)
    expect(latestModels([model("x", "2026-13-40", "f")], now).size).toBe(0)
  })

  test("accepts year-month dates", () => {
    expect(latestModels([model("a", "2026-09", "f")], now).has("p:a")).toBe(true)
    expect(latestModels([model("a", "2026-09-30", "f")], now).has("p:a")).toBe(true)
    expect(latestModels([model("a", "2025-01-01", "f")], now).has("p:a")).toBe(false)
  })
})

describe("modelVisible", () => {
  const latest = new Set(["p:new"])

  test("an explicit override wins over the latest set and the date", () => {
    const override = new Map<string, boolean | undefined>([
      ["p:new", false],
      ["p:old", true],
    ])
    expect(modelVisible(model("new", daysAgo(1)), latest, override)).toBe(false)
    expect(modelVisible(model("old", daysAgo(900)), latest, override)).toBe(true)
  })

  test("an undefined override entry falls through", () => {
    expect(modelVisible(model("new", daysAgo(1)), latest, new Map([["p:new", undefined]]))).toBe(true)
  })

  test("latest models show, other dated models hide", () => {
    expect(modelVisible(model("new", daysAgo(1)), latest)).toBe(true)
    expect(modelVisible(model("old", daysAgo(900)), latest)).toBe(false)
  })

  test("models without a valid release date show", () => {
    expect(modelVisible(model("none"), latest)).toBe(true)
    expect(modelVisible(model("bad", "nope"), latest)).toBe(true)
  })
})

describe("withoutDeprecated", () => {
  test("drops deprecated models and keeps the rest", () => {
    const models = { a: { id: "a", status: "active" }, b: { id: "b", status: "deprecated" }, c: { id: "c" } }
    expect(Object.keys(withoutDeprecated(models))).toEqual(["a", "c"])
  })
})

describe("defaultModel", () => {
  const providers = new Map([
    ["one", { models: { a: { id: "a" }, b: { id: "b" } } }],
    ["two", { models: { c: { id: "c" } } }],
    ["empty", { models: {} }],
  ])

  test("uses the configured default of the first connected provider", () => {
    expect(defaultModel(providers, { one: "b" }, ["one", "two"])).toEqual({ providerID: "one", modelID: "b" })
  })

  test("falls back to the provider's first model", () => {
    expect(defaultModel(providers, {}, ["one"])).toEqual({ providerID: "one", modelID: "a" })
    expect(defaultModel(providers, { one: "missing" }, ["one"])).toEqual({ providerID: "one", modelID: "a" })
  })

  test("walks connected providers in the given order and skips unknown or empty ones", () => {
    expect(defaultModel(providers, {}, ["ghost", "empty", "two", "one"])).toEqual({ providerID: "two", modelID: "c" })
  })

  test("the availability check moves the walk on", () => {
    const available = (key: { providerID: string; modelID: string }) => key.providerID !== "one"
    expect(defaultModel(providers, { one: "b" }, new Set(["one", "two"]), available)).toEqual({
      providerID: "two",
      modelID: "c",
    })
    expect(defaultModel(providers, { one: "b" }, ["one"], (key) => key.modelID === "a")).toEqual({
      providerID: "one",
      modelID: "a",
    })
  })

  test("returns nothing when no connected provider qualifies", () => {
    expect(defaultModel(providers, {}, [])).toBeUndefined()
    expect(defaultModel(providers, {}, ["empty"])).toBeUndefined()
  })
})

describe("pushRecent", () => {
  const key = (modelID: string, providerID = "p") => ({ providerID, modelID })

  test("puts the model first and drops its earlier entry", () => {
    expect(pushRecent([key("a"), key("b"), key("c")], key("b"))).toEqual([key("b"), key("a"), key("c")])
  })

  test("keeps at most five by default and honours a custom limit", () => {
    const list = ["a", "b", "c", "d", "e"].map((id) => key(id))
    expect(pushRecent(list, key("f")).map((item) => item.modelID)).toEqual(["f", "a", "b", "c", "d"])
    expect(pushRecent(list, key("e")).map((item) => item.modelID)).toEqual(["e", "a", "b", "c", "d"])
    expect(pushRecent(list, key("f"), 2).map((item) => item.modelID)).toEqual(["f", "a"])
  })

  test("same model id under another provider is distinct and the input is untouched", () => {
    const list = [key("a", "one")]
    expect(pushRecent(list, key("a", "two"))).toEqual([key("a", "two"), key("a", "one")])
    expect(list).toEqual([key("a", "one")])
  })
})

test("modelKey joins provider and model ids", () => {
  expect(modelKey({ providerID: "p", id: "m" })).toBe("p:m")
})
