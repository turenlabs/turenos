import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ServerMode } from "@/server/mode"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { ProcessEnv } from "@turenlabs/core/process-env"

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
    throw new ServerMode.ConfigError("persistent server requires the systemd-credentials secret vault key source")

  // Children inherit process.env, so the variables go in every branch, including systemd-credentials.
  const keyID = env.FORGE_SECRET_VAULT_KEY_ID
  const encodedKey = env.FORGE_SECRET_VAULT_KEY
  if (env === process.env) ProcessEnv.remove(["FORGE_SECRET_VAULT_KEY_ID", "FORGE_SECRET_VAULT_KEY"])

  if (source === "systemd-credentials") {
    const directory = env.CREDENTIALS_DIRECTORY
    if (!directory) throw ServerMode.configError("systemd credential directory is unavailable", env)
    const [id, encoded] = await Promise.all([
      readFile(join(directory, "forge-secret-vault-key-id"), "utf8").then((value) => value.trim()),
      readFile(join(directory, "forge-secret-vault-key"), "utf8").then((value) => value.trim()),
    ]).catch((error: Error) => {
      throw ServerMode.configError(`cannot read the secret vault key credential: ${error.message}`, env)
    })
    try {
      return parseKey(id, encoded)
    } catch (error) {
      throw ServerMode.configError((error as Error).message, env)
    }
  }

  if (keyID === undefined && encodedKey === undefined) return undefined
  return parseKey(keyID ?? "", encodedKey ?? "")
}

export function parseKey(keyID: string, encodedKey: string): Key {
  const key = Buffer.from(encodedKey, "base64")
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyID) || key.byteLength !== 32 || key.toString("base64") !== encodedKey)
    throw new Error("secret vault key source contains invalid key material")
  return { keyID, key: new Uint8Array(key) }
}
