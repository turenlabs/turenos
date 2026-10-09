export * as ServerOwnership from "./ownership"

import { Database } from "@turenlabs/core/database/database"
import { SecretVault } from "@turenlabs/core/secret-vault"
import type { Source } from "@/cli/secret-vault-key"
import { ServerMode } from "./mode"
import { isLoopbackHostname } from "./shared/local-request"
import { ServerOwner } from "@turenlabs/core/database/server-owner"

export type Options = {
  hostname?: string
  mdns?: boolean
  keySource?: Source
  credentialVault?: SecretVault.Key
  password?: string
}

/**
 * Validates persistent-mode inputs, installs the vault key, and takes
 * the database owner lock. It must run before any layer that can open the database, so the
 * owner check precedes migrations and key verification precedes every secret read.
 */
export async function acquire(opts: Options) {
  const mode = ServerOwner.mode()
  if (mode === "persistent") {
    ServerMode.assertNoSecretsInEnvironment()
    if (opts.keySource !== "systemd-credentials")
      throw new ServerMode.ConfigError("persistent server requires the systemd-credentials secret vault key source")
    if (!opts.credentialVault)
      throw new ServerMode.ConfigError("persistent server requires a host-loaded secret vault key")
    if (!process.env.FORGE_SERVER_ID)
      throw new ServerMode.ConfigError("persistent server requires a stable FORGE_SERVER_ID")
    if (!opts.password) throw new ServerMode.ConfigError("persistent server requires a protected HTTP password")
    // The password travels as plaintext Basic auth, so the listener must not leave the host.
    if (opts.hostname !== undefined && !isLoopbackHostname(opts.hostname))
      throw new ServerMode.ConfigError(
        `persistent server must listen on a loopback hostname, not ${opts.hostname}; remove --hostname from the unit`,
      )
    if (opts.mdns)
      throw new ServerMode.ConfigError("persistent server must not publish over mDNS; remove --mdns from the unit")
  }
  if (opts.credentialVault) SecretVault.configure(opts.credentialVault)
  const release = await Database.acquireOwnerLock(Database.path(), {
    mode,
    serverID: mode === "persistent" ? process.env.FORGE_SERVER_ID : undefined,
    keyID: opts.credentialVault?.keyID ?? process.env.FORGE_SECRET_VAULT_KEY_ID,
    key: opts.credentialVault,
  })
  return release
}
