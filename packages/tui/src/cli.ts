#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { appendFileSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { version } from "../package.json"
import { CliError, resolveTuiAuth } from "./tui-auth"
import { checkDirectory, identifier } from "./response-validation"
import { checkUsername, origin } from "./agent/address"
import { agentOverview, isAgentCommand, isCommandWord } from "./agent/words"

const help = `Usage: turen-tui [url] [options]

Open the terminal dashboard for TurenOS. Without a URL it connects to TurenOS on
this computer: the running desktop app, then this host's quick-connect or
persistent server. Press s in the dashboard to switch servers.

Options:
  --server <name>    Open a saved server (see the s server picker)
  --dir <path>       Absolute project directory on the server (POSIX or Windows)
  --session <id>     Open this session (ses_…) first, as printed by turen-tui sessions
  --username <name>  Basic auth username
  --discover-auth   Trust the local listener and discover turenos.service auth
                    (Linux, same user, http://127.0.0.1:4096 only; off by default)
  -h, --help        Show this help
  -v, --version     Show the version

Server URL: positional URL, then TURENOS_SERVER_URL, then local discovery.
Use an HTTP(S) origin without credentials, a path prefix, query, or fragment.
Username: --username, then FORGE_SERVER_USERNAME, discovered username, then forge.
Password: FORGE_SERVER_PASSWORD only; an explicitly empty value disables auth
and discovery. There is no password flag. Credentials require HTTPS except for
HTTP on 127.0.0.1 or [::1]. Saved servers live in
$XDG_CONFIG_HOME/turen-tui/servers.json and never store passwords.
The dashboard needs an interactive terminal on stdin and stdout.

${agentOverview}`

export function parseCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        server: { type: "string" },
        dir: { type: "string" },
        session: { type: "string" },
        username: { type: "string" },
        "discover-auth": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    })
    if (parsed.values.help) return { kind: "help" as const }
    if (parsed.values.version) return { kind: "version" as const }
    if (parsed.positionals.length > 1) throw new CliError({ message: "Provide at most one server URL." })
    const server = parsed.values.server
    if (server !== undefined && parsed.positionals.length)
      throw new CliError({ message: "Use either a server URL or --server, not both." })
    if (server !== undefined && (!server.trim() || server.length > 128 || /[\u0000-\u001f\u007f]/.test(server)))
      throw new CliError({ message: "--server must name a saved server." })

    // --discover-auth keeps its original loopback target; otherwise no URL means local discovery.
    const address =
      server === undefined
        ? (parsed.positionals[0] ??
          env.TURENOS_SERVER_URL ??
          (parsed.values["discover-auth"] ? "http://127.0.0.1:4096" : undefined))
        : undefined
    const url = address === undefined ? undefined : origin(address)
    if (parsed.values.dir !== undefined) {
      try {
        checkDirectory(parsed.values.dir)
      } catch {
        throw new CliError({ message: "--dir must be an absolute directory on the server." })
      }
    }
    if (parsed.values.session !== undefined) {
      try {
        identifier(parsed.values.session, "ses_")
      } catch {
        throw new CliError({ message: "--session must be a session ID such as ses_…." })
      }
    }
    return {
      kind: "run" as const,
      url,
      directory: parsed.values.dir,
      session: parsed.values.session,
      username: parsed.values.username,
      discoverAuth: parsed.values["discover-auth"],
      server,
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    // parseArgs errors may echo argument values, including misplaced credentials.
    throw new CliError({ message: "Invalid arguments. Run turen-tui --help for usage." })
  }
}

// Bun exits the process on unhandled rejections and uncaught exceptions, which
// kills the whole dashboard window and drops every server connection. Log the
// failure and keep running; the dashboard's own reconnect loops recover.
// Never write credentials or request URLs to the log.
function reportCrash(kind: string, error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const line = `${new Date().toISOString()} ${kind} ${message.replace(/https?:\/\/\S+/g, "[url]")}\n`
  const base = process.env.XDG_STATE_HOME || (process.env.HOME ? `${process.env.HOME}/.local/state` : undefined)
  if (!base) return
  try {
    const path = `${base}/turen-tui/error.log`
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // Failures name sessions and servers: keep the log private, and stop appending past 1 MiB.
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) return
    appendFileSync(path, line, { mode: 0o600 })
  } catch {
    // Crash reporting must never take the TUI down.
  }
}

export async function main(args = process.argv.slice(2)) {
  if (isAgentCommand(args[0]) || isCommandWord(args[0])) {
    // Agent commands never need a terminal and never load the renderer. A mistyped command word reaches
    // them too, so it fails as a usage error instead of being read as a server URL.
    const { runAgent, processIo } = await import("./agent")
    process.exitCode = await runAgent(args, processIo())
    return
  }
  // Only the dashboard survives a crash this way; an agent command must fail loudly, not hang.
  process.on("unhandledRejection", (reason) => reportCrash("unhandledRejection", reason))
  process.on("uncaughtException", (error) => reportCrash("uncaughtException", error))
  const options = parseCli(args)
  if (options.kind === "help") return console.log(help)
  if (options.kind === "version") return console.log(version)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError({
      message:
        "The dashboard needs an interactive terminal. For scripts and agents, use the commands in turen-tui --help (e.g. turen-tui sessions --json).",
    })
  }
  // Discovered servers publish their own credentials; only an explicit URL needs these.
  const auth = options.url
    ? await resolveTuiAuth({
        url: options.url,
        username: options.username,
        discoverAuth: options.discoverAuth,
        env: process.env,
      })
    : { username: options.username ?? process.env.FORGE_SERVER_USERNAME ?? "forge" }
  checkUsername(auth.username)
  const { runTui } = await import("./index")
  await runTui(
    options.url && "password" in auth
      ? {
          url: options.url.href,
          directory: options.directory,
          session: options.session,
          username: auth.username,
          password: auth.password,
        }
      : { directory: options.directory, session: options.session, username: options.username, server: options.server },
  )
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`turen-tui: ${error instanceof CliError ? error.message : "Unable to start the terminal client."}`)
    process.exitCode = 1
  })
}
