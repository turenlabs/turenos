import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const TAURI_APP_IDS: Record<string, string> = {
  dev: "com.turenlabs.forge.dev",
  beta: "com.turenlabs.forge.beta",
  prod: "com.turenlabs.forge",
}

export function readTauriLegacyStores(dir: string, warn?: (message: string, error: Error) => void) {
  const stores = new Map<string, Record<string, unknown>>()
  const failures = new Map<string, Error>()
  if (existsSync(dir)) {
    readdirSync(dir)
      .filter((filename) => filename.endsWith(".dat"))
      .forEach((filename) => {
        const name = filename === "forge.settings.dat" ? "forge.settings" : filename
        try {
          const parsed = JSON.parse(readFileSync(join(dir, filename), "utf8")) as unknown
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            failures.set(name, new Error(`Tauri legacy store is not an object: ${filename}`))
            return
          }
          stores.set(name, parsed as Record<string, unknown>)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          failures.set(name, failure)
          warn?.(`tauri import source could not be read: ${filename}`, failure)
        }
      })
  }

  return {
    merge(name: string, electron: { store: Record<string, unknown> }) {
      const failure = failures.get(name)
      if (failure) throw failure
      return { store: { ...(stores.get(name) ?? {}), ...electron.store } }
    },
  }
}

export function currentTauriLegacyDir(packaged: boolean, channel: string) {
  return tauriDir(packaged ? (TAURI_APP_IDS[channel] ?? TAURI_APP_IDS.dev) : TAURI_APP_IDS.dev)
}

function tauriDir(id: string) {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", id)
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id)
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), id)
  }
}
