import * as i18n from "@solid-primitives/i18n"

import { dict as desktopEn } from "./en"
import { dict as appEn } from "../../../../app/src/i18n/en"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "uk"
  | "ar"
  | "no"
  | "br"
  | "bs"

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = i18n.Flatten<RawDictionary>
type Source = { dict: Record<string, string> }

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "no",
  "br",
]

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("en")) return "en"
    if (language.toLowerCase().startsWith("zh")) {
      if (language.toLowerCase().includes("hant")) return "zht"
      return "zh"
    }
    if (language.toLowerCase().startsWith("ko")) return "ko"
    if (language.toLowerCase().startsWith("de")) return "de"
    if (language.toLowerCase().startsWith("es")) return "es"
    if (language.toLowerCase().startsWith("fr")) return "fr"
    if (language.toLowerCase().startsWith("da")) return "da"
    if (language.toLowerCase().startsWith("ja")) return "ja"
    if (language.toLowerCase().startsWith("pl")) return "pl"
    if (language.toLowerCase().startsWith("ru")) return "ru"
    if (language.toLowerCase().startsWith("uk")) return "uk"
    if (language.toLowerCase().startsWith("ar")) return "ar"
    if (
      language.toLowerCase().startsWith("no") ||
      language.toLowerCase().startsWith("nb") ||
      language.toLowerCase().startsWith("nn")
    )
      return "no"
    if (language.toLowerCase().startsWith("pt")) return "br"
    if (language.toLowerCase().startsWith("bs")) return "bs"
  }

  return "en"
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

// Every locale statically imported here lands in the renderer's entry chunk, so
// the 15 the user is not running would be parsed on each launch for nothing.
const merge = (app: Promise<Source>, desktop: Promise<Source>) =>
  Promise.all([app, desktop]).then(
    ([a, b]) => ({ ...base, ...i18n.flatten(a.dict), ...i18n.flatten(b.dict) }) as Dictionary,
  )

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  zh: () => merge(import("../../../../app/src/i18n/zh"), import("./zh")),
  zht: () => merge(import("../../../../app/src/i18n/zht"), import("./zht")),
  ko: () => merge(import("../../../../app/src/i18n/ko"), import("./ko")),
  de: () => merge(import("../../../../app/src/i18n/de"), import("./de")),
  es: () => merge(import("../../../../app/src/i18n/es"), import("./es")),
  fr: () => merge(import("../../../../app/src/i18n/fr"), import("./fr")),
  da: () => merge(import("../../../../app/src/i18n/da"), import("./da")),
  ja: () => merge(import("../../../../app/src/i18n/ja"), import("./ja")),
  pl: () => merge(import("../../../../app/src/i18n/pl"), import("./pl")),
  ru: () => merge(import("../../../../app/src/i18n/ru"), import("./ru")),
  uk: () => merge(import("../../../../app/src/i18n/uk"), import("./uk")),
  ar: () => merge(import("../../../../app/src/i18n/ar"), import("./ar")),
  no: () => merge(import("../../../../app/src/i18n/no"), import("./no")),
  br: () => merge(import("../../../../app/src/i18n/br"), import("./br")),
  bs: () => merge(import("../../../../app/src/i18n/bs"), import("./bs")),
}

const dicts = new Map<Locale, Dictionary>()

function build(locale: Locale): Promise<Dictionary> {
  if (locale === "en") return Promise.resolve(base)
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  return loaders[locale]().then((next: Dictionary) => {
    dicts.set(locale, next)
    return next
  })
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("forge.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    // Claim the locale only once its dictionary is in hand: a failed chunk load
    // is swallowed below, and reporting a locale we are not rendering is worse
    // than reporting the one we are.
    state.dict = await build(next)
    state.locale = next
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
