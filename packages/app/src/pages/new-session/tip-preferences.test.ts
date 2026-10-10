import { expect, test } from "bun:test"
import { readTipPreferences, tipStorage, writeTipPreference } from "./tip-preferences"

const today = "2026-09-29"

function memory() {
  const values = new Map<string, string>()
  const writes: string[] = []
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key)
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

test("defaults on only after successfully reading absent preferences", async () => {
  const store = memory()
  expect(await readTipPreferences(store, today)).toEqual({ enabled: true, hiddenDay: undefined })
  expect(store.writes).toEqual([])
  store.values.set("daily-tips.enabled", "false")
  expect(await readTipPreferences(store, today)).toEqual({ enabled: false, hiddenDay: undefined })
  expect(store.writes).toEqual([])
})

test("fails closed on malformed, future, or unreadable state without changing storage", async () => {
  const store = memory()
  store.values.set("daily-tips.enabled", "maybe")
  expect(await readTipPreferences(store, today)).toBeUndefined()
  store.values.set("daily-tips.enabled", "true")
  store.values.set("daily-tips.hiddenDay", "2026-09-30")
  expect(await readTipPreferences(store, today)).toBeUndefined()
  store.values.set("daily-tips.hiddenDay", "2026-09-29")
  expect(await readTipPreferences(store, today)).toEqual({ enabled: true, hiddenDay: today })
  expect(store.writes).toEqual([])
  expect(
    await readTipPreferences(
      {
        getItem: () => {
          throw new Error("inaccessible")
        },
        setItem: store.setItem,
        removeItem: store.removeItem,
      },
      today,
    ),
  ).toBeUndefined()
  expect(store.writes).toEqual([])
})

test("writes only an explicit preference change and verifies it was saved", async () => {
  const store = memory()
  expect(await writeTipPreference(store, "daily-tips.enabled", "false")).toBe(true)
  expect(store.writes).toEqual(["daily-tips.enabled"])
  expect(
    await writeTipPreference(
      { getItem: () => null, setItem: store.setItem, removeItem: store.removeItem },
      "daily-tips.hiddenDay",
      today,
    ),
  ).toBe(false)
  store.values.set("daily-tips.hiddenDay", "not-a-day")
  expect(await writeTipPreference(store, "daily-tips.hiddenDay", null)).toBe(true)
  expect(store.values.has("daily-tips.hiddenDay")).toBe(false)
})

test("browser and desktop adapters use the same profile-local keys", async () => {
  const browser = memory()
  const desktop = memory()
  const webStore = tipStorage({ platform: "web" }, browser)
  const desktopStore = tipStorage({ platform: "desktop", storage: () => desktop }, browser)
  expect(await writeTipPreference(webStore, "daily-tips.enabled", "false")).toBe(true)
  expect(browser.values.get("forge.global.dat:daily-tips.enabled")).toBe("false")
  expect(await writeTipPreference(desktopStore, "daily-tips.enabled", "false")).toBe(true)
  expect(desktop.values.get("daily-tips.enabled")).toBe("false")
  expect(browser.writes).toEqual(["forge.global.dat:daily-tips.enabled"])
  expect(await writeTipPreference(webStore, "daily-tips.enabled", null)).toBe(true)
  expect(browser.values.has("forge.global.dat:daily-tips.enabled")).toBe(false)
  expect(await writeTipPreference(desktopStore, "daily-tips.enabled", null)).toBe(true)
  expect(desktop.values.has("daily-tips.enabled")).toBe(false)
})
