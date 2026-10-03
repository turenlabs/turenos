import type { Platform } from "@/context/platform"
import { Persist } from "@/utils/persist"

export type TipStore = {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): unknown
  removeItem(key: string): unknown
}

type Preferences = { enabled: boolean; hiddenDay?: string }

const enabledKey = "daily-tips.enabled"
const hiddenDayKey = "daily-tips.hiddenDay"

export function tipStorage(platform: Pick<Platform, "platform" | "storage">, browser?: TipStore): TipStore {
  const scope = Persist.global(enabledKey).storage
  return {
    getItem(key) {
      if (platform.platform === "desktop") {
        if (!platform.storage) throw new Error("Desktop storage unavailable")
        return platform.storage(scope).getItem(key)
      }
      return (browser ?? localStorage).getItem(`${scope}:${key}`)
    },
    setItem(key, value) {
      if (platform.platform === "desktop") {
        if (!platform.storage) throw new Error("Desktop storage unavailable")
        return platform.storage(scope).setItem(key, value)
      }
      return (browser ?? localStorage).setItem(`${scope}:${key}`, value)
    },
    removeItem(key) {
      if (platform.platform === "desktop") {
        if (!platform.storage) throw new Error("Desktop storage unavailable")
        return platform.storage(scope).removeItem(key)
      }
      return (browser ?? localStorage).removeItem(`${scope}:${key}`)
    },
  }
}

export async function readTipPreferences(storage: TipStore, today: string): Promise<Preferences | undefined> {
  try {
    const enabled = await storage.getItem(enabledKey)
    const hiddenDay = await storage.getItem(hiddenDayKey)
    if (enabled !== null && enabled !== "true" && enabled !== "false") return undefined
    if (hiddenDay !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(hiddenDay) || hiddenDay > today) return undefined
      if (new Date(hiddenDay).toISOString().slice(0, 10) !== hiddenDay) return undefined
    }
    return { enabled: enabled !== "false", hiddenDay: hiddenDay ?? undefined }
  } catch {
    return undefined
  }
}

export async function writeTipPreference(
  storage: TipStore,
  key: typeof enabledKey | typeof hiddenDayKey,
  value: string | null,
) {
  try {
    if (value === null) await storage.removeItem(key)
    else await storage.setItem(key, value)
    return (await storage.getItem(key)) === value
  } catch {
    return false
  }
}
