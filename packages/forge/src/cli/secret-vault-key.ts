import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ServerMode } from "@/server/mode"
import { ServerOwner } from "@turenlabs/core/database/server-owner"

type Key = { keyID: string; key: Uint8Array }

export const sources = ["env", "systemd-credentials"] as const
export type Source = (typeof sources)[number]

export function selectedSource(env = process.env, override?: string): Source | undefined {
  const source = override ?? env.FORGE_SECRET_VAULT_KEY_SOURCE
  if (source === undefined) return undefined
  if (!sources.includes(source as Source)) throw new Error(`unsupported secret vault key source: ${source}`)
  return source as Source
}

export async function loadSecretVaultKey(env = process.env, override?: string): Promise<Key | undefined> {
  const source = selectedSource(env, override)
  const persistent = ServerOwner.mode(env) === "persistent"
  ServerMode.assertNoSecretsInEnvironment(env)
  if (persistent && source !== "systemd-credentials")
    throw new Error("persistent server requires the systemd-credentials secret vault key source")

  if (source === "systemd-credentials") {
    const directory = env.CREDENTIALS_DIRECTORY
    if (!directory) throw new Error("systemd credential directory is unavailable")
    const [keyID, encodedKey] = await Promise.all([
      readFile(join(directory, "forge-secret-vault-key-id"), "utf8").then((value) => value.trim()),
      readFile(join(directory, "forge-secret-vault-key"), "utf8").then((value) => value.trim()),
    ])
    return parseKey(keyID, encodedKey)
  }

  const keyID = env.FORGE_SECRET_VAULT_KEY_ID
  const encodedKey = env.FORGE_SECRET_VAULT_KEY
  if (keyID === undefined && encodedKey === undefined) return undefined
  const key = parseKey(keyID ?? "", encodedKey ?? "")
  if (env === process.env) {
    delete process.env.FORGE_SECRET_VAULT_KEY_ID
    delete process.env.FORGE_SECRET_VAULT_KEY
  }
  return key
}

export function parseKey(keyID: string, encodedKey: string): Key {
  const key = Buffer.from(encodedKey, "base64")
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyID) || key.byteLength !== 32 || key.toString("base64") !== encodedKey)
    throw new Error("secret vault key source contains invalid key material")
  return { keyID, key: new Uint8Array(key) }
}
