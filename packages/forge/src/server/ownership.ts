export * as ServerOwnership from "./ownership"

import { Database } from "@turenlabs/core/database/database"
import { SecretVault } from "@turenlabs/core/secret-vault"
import type { Source } from "@/cli/secret-vault-key"
import { ServerAuth } from "./auth"
import { ServerMode } from "./mode"
import { ServerOwner } from "@turenlabs/core/database/server-owner"

export type Options = {
  keySource?: Source
  credentialVault?: SecretVault.Key
  serverAuth?: { password: string; username?: string }
}

/**
 * Validates persistent-mode inputs, installs the vault key and listener credentials, and takes
 * the database owner lock. It must run before any layer that can open the database, so the
 * owner check and key verification precede migrations and every secret read.
 */
export async function acquire(opts: Options) {
  const mode = ServerOwner.mode()
  if (mode === "persistent") {
    ServerMode.assertNoSecretsInEnvironment()
    if (opts.keySource !== "systemd-credentials")
      throw new Error("persistent server requires the systemd-credentials secret vault key source")
    if (!opts.credentialVault) throw new Error("persistent server requires a host-loaded secret vault key")
    if (!process.env.FORGE_SERVER_ID) throw new Error("persistent server requires a stable FORGE_SERVER_ID")
    if (!opts.serverAuth?.password) throw new Error("persistent server requires a protected HTTP password")
  }
  if (opts.credentialVault) SecretVault.configure(opts.credentialVault)
  const release = await Database.acquireOwnerLock(Database.path(), {
    mode,
    serverID: mode === "persistent" ? process.env.FORGE_SERVER_ID : undefined,
    keyID: opts.credentialVault?.keyID ?? process.env.FORGE_SECRET_VAULT_KEY_ID,
    key: opts.credentialVault,
  })
  if (!opts.serverAuth) return release
  const previous = ServerAuth.configure(opts.serverAuth)
  return () => {
    ServerAuth.configure(previous)
    release()
  }
}
