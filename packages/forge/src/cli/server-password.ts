import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Flag } from "@turenlabs/core/flag/flag"
import { ServerMode } from "@/server/mode"
import { ServerOwner } from "@turenlabs/core/database/server-owner"

export async function loadServerPassword(env = process.env): Promise<string | undefined> {
  const persistent = ServerOwner.mode(env) === "persistent"
  ServerMode.assertNoSecretsInEnvironment(env)
  const name = env.FORGE_SERVER_PASSWORD_CREDENTIAL
  if (!name) {
    if (persistent) throw new ServerMode.ConfigError("persistent server requires FORGE_SERVER_PASSWORD_CREDENTIAL")
    return env.FORGE_SERVER_PASSWORD ?? Flag.FORGE_SERVER_PASSWORD
  }
  if (!env.CREDENTIALS_DIRECTORY) throw ServerMode.configError("systemd credential directory is unavailable", env)
  if (name !== basename(name)) throw ServerMode.configError("systemd credential names must be file names", env)
  // systemd owns $CREDENTIALS_DIRECTORY and exposes credentials as 0440 in a service-private mount.
  const password = (
    await readFile(join(env.CREDENTIALS_DIRECTORY, name), "utf8").catch((error: Error) => {
      throw ServerMode.configError(`cannot read the server password credential: ${error.message}`, env)
    })
  ).trim()
  if (!password) throw ServerMode.configError("server password credential is empty", env)
  return password
}
