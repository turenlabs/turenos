import { describe, expect, test } from "bun:test"
import { resolveInitialLocale } from "./language"

describe("language initial authority", () => {
  test("does not read browser localStorage when an external Desktop source owns bootstrap", () => {
    const reads = { count: 0 }
    const locale = resolveInitialLocale({
      source: "external",
      readStored: () => {
        reads.count += 1
        return "fr"
      },
      detect: () => "de",
    })

    expect(locale).toBe("de")
    expect(reads.count).toBe(0)
  })

  test("preserves browser localStorage precedence for the web client", () => {
    expect(
      resolveInitialLocale({
        source: "browser",
        readStored: () => "fr",
        detect: () => "de",
      }),
    ).toBe("fr")
  })
})
