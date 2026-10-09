export * as ServerOwnership from "./ownership"

import { Database } from "@turenlabs/core/database/database"
import { SecretVault } from "@turenlabs/core/secret-vault"
import type { Source } from "@/cli/secret-vault-key"
import { ServerMode } from "./mode"
import { isLoopbackHostname } from "./shared/local-request"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

export type Options = {
  hostname?: string
  mdns?: boolean
  keySource?: Source
  credentialVault?: SecretVault.Key
  password?: string
  socketPath?: string
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
    if (!opts.socketPath)
      throw new ServerMode.ConfigError("persistent server requires --socket-path; TCP listeners are not permitted")
    // The password travels as plaintext Basic auth, so the listener must not leave the host.
    if (opts.hostname !== undefined && !isLoopbackHostname(opts.hostname))
      throw new ServerMode.ConfigError(
        `persistent server must listen on a loopback hostname, not ${opts.hostname}; remove --hostname from the unit`,
      )
    if (opts.mdns)
      throw new ServerMode.ConfigError("persistent server must not publish over mDNS; remove --mdns from the unit")
  }
  if (opts.socketPath) await validateSocketPath(opts.socketPath, mode === "persistent")
  if (opts.credentialVault) SecretVault.configure(opts.credentialVault)
  const release = await Database.acquireOwnerLock(Database.path(), {
    mode,
    serverID: mode === "persistent" ? process.env.FORGE_SERVER_ID : undefined,
    keyID: opts.credentialVault?.keyID ?? process.env.FORGE_SECRET_VAULT_KEY_ID,
    key: opts.credentialVault,
  })
  return release
}

async function validateSocketPath(socketPath: string, persistent: boolean) {
  if (!path.isAbsolute(socketPath)) throw new ServerMode.ConfigError("socket path must be absolute")
  const parent = path.dirname(socketPath)
  const directory = await lstat(parent).catch(() => {
    throw new ServerMode.ConfigError("socket parent directory is unavailable")
  })
  if (!directory.isDirectory() || (await realpath(parent)) !== parent)
    throw new ServerMode.ConfigError("socket parent must be a directory without symlinks")
  if (persistent && directory.uid !== 0 && directory.uid !== process.getuid?.())
    throw new ServerMode.ConfigError("socket parent must belong to root or the service user")
  if (persistent && (directory.mode & 0o022) !== 0)
    throw new ServerMode.ConfigError("socket parent must not allow group or other write access")
  const target = await lstat(socketPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw new ServerMode.ConfigError("cannot inspect socket path")
  })
  // Bun owns socket cleanup. Never remove a target that another process can own.
  if (target) throw new ServerMode.ConfigError("socket path already exists; refusing to replace it")
}
