import { expect, test } from "bun:test"
import { localeFromLanguages } from "./index"

test("picks Traditional Chinese for region tags that use Traditional script", () => {
  expect(localeFromLanguages(["zh-TW", "zh"])).toBe("zht")
  expect(localeFromLanguages(["zh-HK"])).toBe("zht")
  expect(localeFromLanguages(["zh-MO"])).toBe("zht")
  expect(localeFromLanguages(["zh-Hant-TW"])).toBe("zht")
})

test("keeps Simplified Chinese for Simplified regions and explicit Hans tags", () => {
  expect(localeFromLanguages(["zh-CN"])).toBe("zh")
  expect(localeFromLanguages(["zh"])).toBe("zh")
  expect(localeFromLanguages(["zh-Hans-HK"])).toBe("zh")
})
