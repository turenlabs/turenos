#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { version } from "../package.json"
import { CliError, resolveTuiAuth } from "./tui-auth"
import { checkDirectory } from "./response-validation"

const help = `Usage: turen-tui [url] [options]

Open the terminal dashboard for TurenOS. Without a URL it connects to TurenOS on
this computer: the running desktop app, then this host's quick-connect or
persistent server. Press s in the dashboard to switch servers.

Options:
  --server <name>    Open a saved server (see the s server picker)
  --dir <path>       Absolute project directory on the server (POSIX or Windows)
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
Both stdin and stdout must be interactive terminals.`

export function parseCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        server: { type: "string" },
        dir: { type: "string" },
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
    return {
      kind: "run" as const,
      url,
      directory: parsed.values.dir,
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

function origin(address: string) {
  const url = address.length <= 8192 ? URL.parse(address) : null
  if (!url || !/^https?:\/\//i.test(address) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new CliError({
      message: "The server URL must be a valid http:// or https:// origin (at most 8192 characters).",
    })
  }
  if (url.username || url.password || address.includes("@")) {
    throw new CliError({ message: "Use --username and FORGE_SERVER_PASSWORD for server authentication." })
  }
  // Check the original text too: URL parsing erases empty delimiters, whitespace, and dot segments.
  if (address.includes("?") || address.includes("#")) {
    throw new CliError({ message: "The server URL must not include a query string or fragment." })
  }
  if (
    url.pathname !== "/" ||
    address.trim() !== address ||
    !/^https?:\/\/[^/\\\s\u0000-\u001f\u007f]+\/?$/i.test(address)
  ) {
    throw new CliError({ message: "Use the server's origin URL without a path prefix." })
  }
  return url
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
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line)
  } catch {
    // Crash reporting must never take the TUI down.
  }
}

process.on("unhandledRejection", (reason) => reportCrash("unhandledRejection", reason))
process.on("uncaughtException", (error) => reportCrash("uncaughtException", error))

export async function main(args = process.argv.slice(2)) {
  const options = parseCli(args)
  if (options.kind === "help") return console.log(help)
  if (options.kind === "version") return console.log(version)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError({ message: "The TurenOS dashboard requires an interactive terminal on stdin and stdout." })
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
  if (
    !auth.username ||
    auth.username.length > 512 ||
    auth.username.includes(":") ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(auth.username)
  ) {
    throw new CliError({ message: "Use a valid username without ':' or control characters (at most 512 characters)." })
  }
  const { runTui } = await import("./index")
  await runTui(
    options.url && "password" in auth
      ? { url: options.url.href, directory: options.directory, username: auth.username, password: auth.password }
      : { directory: options.directory, username: options.username, server: options.server },
  )
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`turen-tui: ${error instanceof CliError ? error.message : "Unable to start the terminal client."}`)
    process.exitCode = 1
  })
}
