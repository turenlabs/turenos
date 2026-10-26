import { expect, test } from "bun:test"
import { localeFromLanguages } from "./index"

// Desktop keeps its own matcher for the locales it ships, so it must keep agreeing with the app's.
test("detects the same locale as the app for every locale Desktop ships", async () => {
  const app = await import("../../../../app/src/context/language")
  const tags = [
    ["zh-TW", "zh"],
    ["zh-HK"],
    ["zh-MO"],
    ["zh-Hant-TW"],
    ["zh-CN"],
    ["zh-Hans-HK"],
    ["zh"],
    ["en-US", "zh-TW"],
    ["ko-KR"],
    ["de"],
    ["es-MX"],
    ["fr-CA"],
    ["da"],
    ["ja-JP"],
    ["pl"],
    ["ru"],
    ["uk"],
    ["ar-EG"],
    ["nb-NO"],
    ["nn"],
    ["pt-BR"],
    ["bs"],
    ["xx", "de-AT"],
    [""],
  ]
  expect(tags.map((languages) => localeFromLanguages(languages))).toEqual(
    tags.map((languages) => app.localeFromLanguages(languages)),
  )
})
