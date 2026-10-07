#!/usr/bin/env bun
// The TUI sandbox: a throwaway TurenOS server with a scripted model, and the TUI driven in a
// private tmux server. See docs/development/tui.md ("Sandbox") for the workflow.
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { join, resolve } from "node:path"
import { alive, checkName, loadRecord, names, packageDir, paths, readPassword } from "./sandbox/run"
import { request, sandboxEnv, start, stop } from "./sandbox/server"
import { menu } from "./sandbox/scenarios"
import { attachCommand, close, exited, keys, open, resize, screen, settle, type, waitFor } from "./sandbox/terminal"

const usage = `Usage: bun run sandbox <command> <name> [options]

Server
  start <name> [--memory-max 3G] [--no-permissions]   Start a sandbox server (10-60 s)
  stop <name> [--keep]                                Stop it and delete its run directory
  list                                                Running sandboxes
  api <name> <METHOD> <path> [json]                   Authenticated request to the sandbox server
  idle <name> [--timeout ms]                          Wait until no session is running
  exec <name> -- <command>...                         Run a command with the sandbox's environment,
                                                      TURENOS_SERVER_URL and FORGE_SERVER_PASSWORD

TUI in your terminal (people)
  tui <name> [--size WxH] [-- turen-tui options]      Run the TUI here against the sandbox

TUI in a private tmux server (agents and tests)
  launch <name> [--size WxH] [--cli path]             Start it in the background (default 120x36);
                                                      --cli runs another entry, e.g. dist/cli.js
  screen <name> [--color]                             Print the screen as plain text
  keys <name> [--] <key>...                           Send keys: Enter Escape C-s Up PageDown S-Enter q
  type <name> [--] <text>                             Type text literally; after -- the text may start with -
  wait <name> <text> [--regex] [--timeout ms]         Wait until the screen shows text
  settle <name>                                       Wait until the screen stops changing
  resize <name> <W>x<H>                               Resize the terminal
  attach <name>                                       Watch or take over (detach: Ctrl+B d)

The run directory is $XDG_RUNTIME_DIR/turen-tui-sandbox/<name> (TUREN_SANDBOX_ROOT overrides).
It never connects to another server and never uses the default tmux server.`

const argv = process.argv.slice(2)
const split = argv.indexOf("--")
const parsed = parseArgs({
  args: split < 0 ? argv : argv.slice(0, split),
  allowPositionals: true,
  options: {
    "memory-max": { type: "string" },
    "no-permissions": { type: "boolean" },
    keep: { type: "boolean" },
    size: { type: "string" },
    cli: { type: "string" },
    color: { type: "boolean" },
    regex: { type: "boolean" },
    timeout: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
})
const [command, name, ...rest] = parsed.positionals
const options = parsed.values
const timeout = options.timeout ? Number(options.timeout) : undefined

const commands: { [command: string]: () => Promise<unknown> | unknown } = {
  async start() {
    const record = await start(checkName(name), {
      memoryMax: options["memory-max"],
      permissions: !options["no-permissions"],
    })
    console.log(
      `Sandbox ${record.name} is running at ${record.url}\nProject folder: ${record.project}\nPermission checks: ${options["no-permissions"] ? "off" : "on (bash asks)"}\n\n${menu()}\n\nNext: bun run sandbox tui ${record.name}   or   bun run sandbox launch ${record.name}`,
    )
  },
  stop: () => stop(checkName(name), options.keep),
  list: () =>
    names().forEach((item) => {
      const record = loadRecord(item)
      console.log(`${item}\t${alive(record.server.pid) ? "running" : "stopped"}\t${record.url}`)
    }),
  async api() {
    const [method, path, body] = rest
    if (!method || !path?.startsWith("/")) throw new Error("Usage: bun run sandbox api <name> <METHOD> </path> [json]")
    console.log(
      JSON.stringify(
        await request(loadRecord(checkName(name)), method.toUpperCase(), path, body ? JSON.parse(body) : undefined),
        null,
        2,
      ),
    )
  },
  async idle() {
    const record = loadRecord(checkName(name))
    const deadline = Date.now() + (timeout ?? 60_000)
    while (Object.keys(((await request(record, "GET", "/api/session/active")) as { data: object }).data).length) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for running sessions to finish.")
      await Bun.sleep(250)
    }
    console.log("idle")
  },
  tui() {
    const record = loadRecord(checkName(name))
    const p = paths(record.name)
    const result = spawnSync(
      "bun",
      [
        join(packageDir, "src/cli.ts"),
        "--dir",
        record.project,
        ...(split < 0 ? [] : argv.slice(split + 1)),
        record.url,
      ],
      {
        stdio: "inherit",
        env: {
          ...sandboxEnv(p),
          TERM: process.env.TERM ?? "xterm-256color",
          COLORTERM: process.env.COLORTERM ?? "",
          FORGE_SERVER_PASSWORD: readPassword(p),
        },
      },
    )
    process.exitCode = result.status ?? 1
  },
  exec() {
    const record = loadRecord(checkName(name))
    const p = paths(record.name)
    if (split < 0 || split === argv.length - 1) throw new Error("Usage: bun run sandbox exec <name> -- <command>...")
    const result = spawnSync(argv[split + 1]!, argv.slice(split + 2), {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...sandboxEnv(p), TURENOS_SERVER_URL: record.url, FORGE_SERVER_PASSWORD: readPassword(p) },
    })
    process.exitCode = result.status ?? 1
  },
  launch() {
    open(checkName(name), size(options.size), {
      cli: options.cli ? resolve(options.cli) : undefined,
      args: split < 0 ? [] : argv.slice(split + 1),
    })
    console.log(
      `TUI launched in a private tmux server. Read it: bun run sandbox screen ${name}\nWatch it: ${attachCommand(name!)}`,
    )
  },
  screen: () => process.stdout.write(screen(checkName(name), options.color)),
  keys: () => keys(checkName(name), ...(split < 0 ? rest : argv.slice(split + 1))),
  type: () => type(checkName(name), (split < 0 ? rest : argv.slice(split + 1)).join(" ")),
  async wait() {
    const text = rest.join(" ")
    if (!text) throw new Error("Usage: bun run sandbox wait <name> <text> [--regex]")
    process.stdout.write(await waitFor(checkName(name), options.regex ? new RegExp(text) : text, timeout))
  },
  settle: async () => process.stdout.write(await settle(checkName(name))),
  resize: () => resize(checkName(name), size(rest[0])),
  attach() {
    spawnSync("sh", ["-c", attachCommand(checkName(name))], { stdio: "inherit" })
  },
  exited: () => console.log(exited(checkName(name)) ? "exited" : "running"),
  close: () => close(checkName(name)),
}

function size(value: string | undefined) {
  if (!value) return { cols: 120, rows: 36 }
  const match = value.match(/^(\d{2,3})x(\d{2,3})$/)
  if (!match) throw new Error("A size is <columns>x<rows>, for example 80x24.")
  return { cols: Number(match[1]), rows: Number(match[2]) }
}

if (options.help || !command || !commands[command]) {
  console.log(usage)
  process.exit(command && !options.help ? 2 : 0)
}
await Promise.resolve(commands[command]!()).catch((error: unknown) => {
  console.error(`sandbox: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
