import { connect } from "../server"
import { createServers, PasswordRequired, type Target } from "../servers"
import { resolveTuiAuth } from "../tui-auth"
import { checkUsername, origin } from "./address"
import { AgentError, usage } from "./errors"
import type { Io } from "./io"
import type { Values } from "./options"

/**
 * Opens the server the options name: an explicit URL, a saved server, or the local TurenOS, in that
 * order, and never a different one when the named one fails. `close` releases the connection and any tunnel.
 */
export async function openServer(values: Values, io: Io) {
  if (values.url !== undefined && values.server !== undefined) throw usage("Use either --url or --server, not both.")
  const server = values.server
  if (server !== undefined && (!server.trim() || server.length > 128 || /[\u0000-\u001f\u007f]/.test(server)))
    throw usage("--server must name a saved server.")
  const address = serverAddress(values, io.env)
  const endpoint = address ? await explicit(address, values, io) : await local(values, io)
  const connection = connect({ url: endpoint.url, username: endpoint.username, password: endpoint.password })
  return {
    connection,
    /** Why a 401 happened, when the caller had no password to blame. */
    unauthorized: endpoint.password ? undefined : endpoint.unauthorized,
    close: () => {
      connection.close()
      endpoint.close?.()
    },
  }
}

// An explicit --url or TURENOS_SERVER_URL wins over discovery, and --server wins over both.
function serverAddress(values: Values, env: NodeJS.ProcessEnv) {
  if (values.server !== undefined) return undefined
  return values.url ?? env.TURENOS_SERVER_URL ?? (values["discover-auth"] ? "http://127.0.0.1:4096" : undefined)
}

async function explicit(address: string, values: Values, io: Io) {
  const url = origin(address)
  const auth = await resolveTuiAuth({
    url,
    username: values.username,
    discoverAuth: values["discover-auth"],
    env: io.env,
  })
  return {
    url: url.href,
    username: checkUsername(auth.username),
    password: auth.password || undefined,
    unauthorized: `The server at ${url.origin} requires a password. Set FORGE_SERVER_PASSWORD in the environment (there is no password flag) and retry.`,
    close: undefined,
  }
}

async function local(values: Values, io: Io) {
  const servers = createServers({ env: io.env, username: values.username })
  await servers.load()
  const target = values.server !== undefined ? servers.find(values.server) : await servers.preferred()
  if (!target)
    throw new AgentError(
      values.server !== undefined
        ? `No saved server named ${values.server}.`
        : "No TurenOS server found on this computer. Pass --url <origin> or --server <name>, or set TURENOS_SERVER_URL.",
    )
  const endpoint = await servers.resolve(target).catch((error: unknown) => {
    throw error instanceof PasswordRequired ? new AgentError(passwordMessage(target, servers.configPath)) : error
  })
  return {
    url: endpoint.url,
    username: checkUsername(endpoint.username),
    password: endpoint.password,
    unauthorized: undefined,
    close: endpoint.close,
  }
}

function passwordMessage(target: Target, configPath: string) {
  if (target.kind === "url" && target.passwordEnv) return `${target.name} needs a password. Set ${target.passwordEnv}.`
  return `${target.name} needs a password. Use --url with FORGE_SERVER_PASSWORD set, or name an environment variable in "passwordEnv" for it in ${configPath}.`
}
