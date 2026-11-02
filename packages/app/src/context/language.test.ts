import { describe, expect, test } from "bun:test"
import { localeFromLanguages, resolveInitialLocale } from "./language"

describe("language detection", () => {
  test("picks Traditional Chinese for region tags that use Traditional script", () => {
    expect(localeFromLanguages(["zh-TW", "zh"])).toBe("zht")
    expect(localeFromLanguages(["zh-HK"])).toBe("zht")
    expect(localeFromLanguages(["zh-MO"])).toBe("zht")
    expect(localeFromLanguages(["zh-Hant"])).toBe("zht")
    expect(localeFromLanguages(["zh-Hant-TW"])).toBe("zht")
  })

  test("keeps Simplified Chinese for Simplified regions and explicit Hans tags", () => {
    expect(localeFromLanguages(["zh-CN"])).toBe("zh")
    expect(localeFromLanguages(["zh-SG"])).toBe("zh")
    expect(localeFromLanguages(["zh"])).toBe("zh")
    expect(localeFromLanguages(["zh-Hans-HK"])).toBe("zh")
    expect(localeFromLanguages(["zh-Hans-TW"])).toBe("zh")
  })

  test("uses the first supported language and falls back to English", () => {
    expect(localeFromLanguages(["en-US", "zh-TW"])).toBe("en")
    expect(localeFromLanguages(["xx", "fr-CA"])).toBe("fr")
    expect(localeFromLanguages(["", "xx"])).toBe("en")
  })
})

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
