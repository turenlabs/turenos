import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  alive,
  createDirs,
  loadRecord,
  paths,
  readPassword,
  remove,
  repoDir,
  saveRecord,
  writePassword,
  type Paths,
  type Record,
} from "./run"

export type StartOptions = { memoryMax?: string; permissions?: boolean }

/**
 * Starts a throwaway TurenOS server from this checkout's source with a scripted model. Everything
 * it writes stays in the run directory; the environment is built from an allowlist so the
 * owner's API keys, servers and configuration never reach it.
 */
export async function start(name: string, options: StartOptions = {}) {
  const p = paths(name)
  if (existsSync(p.record) && alive(loadRecord(name).server.pid))
    throw new Error(`Sandbox ${name} is already running at ${loadRecord(name).url}.`)
  // A leftover run directory (a stopped or failed start) is replaced, never reused.
  remove(p)
  createDirs(p)
  seedProject(p)
  const model = await spawnReady(
    p,
    ["bun", join(import.meta.dir, "model.ts")],
    p.modelLog,
    /MODEL_READY (\d+)/,
    {},
    options,
  )
  writeConfig(p, Number(model.match[1]))
  const password = writePassword(p)
  const server = await spawnReady(
    p,
    // Not `bun run --cwd packages/forge`: the server's working directory is its default location,
    // which must be the sandbox project, never the repository.
    [
      "bun",
      "--conditions=browser",
      join(repoDir, "packages/forge/src/index.ts"),
      "--print-logs",
      "--log-level",
      "WARN",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    p.serverLog,
    /listening on (http:\/\/127\.0\.0\.1:\d+)/,
    serverEnv(password),
    options,
    180_000,
  ).catch((error: unknown) => {
    // No record exists yet, so `stop` could not find the model; end it here.
    signal(model.pid, "SIGKILL")
    throw error
  })
  const record: Record = {
    name,
    url: server.match[1]!,
    username: "forge",
    project: p.project,
    model: { pid: model.pid, port: Number(model.match[1]) },
    server: { pid: server.pid },
    started: Date.now(),
  }
  saveRecord(p, record)
  const location = (await request(record, "GET", "/api/location")) as { directory?: string }
  if (location.directory !== p.project) {
    await stop(name)
    throw new Error(`The sandbox server's location is ${location.directory}, not the sandbox project; stopped it.`)
  }
  if (options.permissions !== false) await request(record, "PUT", "/global/permission-checks", { enforced: true })
  return record
}

/** Stops only the processes this sandbox recorded, then deletes its run directory. */
export async function stop(name: string, keep = false) {
  const p = paths(name)
  if (existsSync(p.socket)) spawnSync("tmux", ["-S", p.socket, "kill-server"], { stdio: "ignore" })
  const record = existsSync(p.record) ? (JSON.parse(readFileSync(p.record, "utf8")) as Record) : undefined
  const pids = record ? [record.server.pid, record.model.pid] : []
  pids.forEach((pid) => signal(pid, "SIGTERM"))
  const deadline = Date.now() + 5000
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(100)
  pids.forEach((pid) => signal(pid, "SIGKILL"))
  if (!keep) remove(p)
}

/** One authenticated request to the sandbox server, for seeding state and checking ground truth. */
export async function request(record: Record, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, record.url), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Basic ${btoa(`${record.username}:${readPassword(paths(record.name))}`)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`)
  // batou:ignore deserialize -- plain JSON.parse of a loopback server this harness started; no object revival
  return text ? (JSON.parse(text) as unknown) : undefined
}

function signal(pid: number, name: NodeJS.Signals) {
  // Each process leads its own group (spawned detached), so this also reaches its children.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, name)
    } catch {}
  }
}

/** A plain git repository with two files, so file views, mentions and diffs have something real to show. */
function seedProject(p: Paths) {
  writeFileSync(join(p.project, "README.md"), "# Sandbox project\n\nHello from the sandbox project.\n")
  writeFileSync(join(p.project, "answer.ts"), "export const answer = 42\n")
  const env = {
    PATH: process.env.PATH,
    HOME: p.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Sandbox",
    GIT_AUTHOR_EMAIL: "sandbox@example.invalid",
    GIT_COMMITTER_NAME: "Sandbox",
    GIT_COMMITTER_EMAIL: "sandbox@example.invalid",
  }
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Seed the sandbox project"],
  ]) {
    const result = spawnSync("git", args, { cwd: p.project, env, stdio: "pipe" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.stdout}`)
  }
}

function writeConfig(p: Paths, port: number) {
  const config = {
    model: "sandbox/scripted",
    autoupdate: false,
    permission: { bash: "ask" },
    provider: {
      sandbox: {
        name: "Sandbox scripted model",
        npm: "@ai-sdk/openai-compatible",
        api: `http://127.0.0.1:${port}/v1`,
        // The server redacts its provider key from error text, so the key must not be a common word.
        options: { apiKey: "sk-scripted-model-0000" },
        models: {
          scripted: {
            name: "Scripted",
            tool_call: true,
            reasoning: true,
            limit: { context: 200000, output: 8192 },
            status: "active",
          },
        },
      },
    },
  }
  mkdirSync(join(p.config, "forge"), { recursive: true })
  writeFileSync(join(p.config, "forge", "forge.json"), `${JSON.stringify(config, null, 2)}\n`)
}

export function sandboxEnv(p: Paths) {
  const pass = ["PATH", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TZ", "TURENOS_REDUCED_MOTION"].filter(
    (key) => process.env[key] !== undefined,
  )
  return {
    ...Object.fromEntries(pass.map((key) => [key, process.env[key]!])),
    HOME: p.home,
    XDG_CONFIG_HOME: p.config,
    XDG_DATA_HOME: p.data,
    XDG_STATE_HOME: p.state,
    XDG_CACHE_HOME: p.cache,
    TMPDIR: p.tmp,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  }
}

function serverEnv(password: string) {
  return {
    FORGE_SERVER_USERNAME: "forge",
    FORGE_SERVER_PASSWORD: password,
    // A throwaway key: the server refuses persistent secret storage without one.
    FORGE_SECRET_VAULT_KEY_ID: "sandbox",
    FORGE_SECRET_VAULT_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    FORGE_DISABLE_MODELS_FETCH: "1",
    FORGE_DISABLE_AUTOUPDATE: "1",
    FORGE_DISABLE_CLAUDE_CODE: "1",
  }
}

/** Spawns a detached process logging to `log`, and waits for `ready` to appear in the log. */
async function spawnReady(
  p: Paths,
  command: string[],
  log: string,
  ready: RegExp,
  env: { [key: string]: string },
  options: StartOptions,
  timeout = 30_000,
) {
  const capped =
    options.memoryMax !== "0" &&
    spawnSync("systemd-run", ["--user", "--scope", "-q", "true"], { stdio: "ignore" }).status === 0
  // systemd-run needs the user bus; `env -u` keeps those variables away from the sandboxed process.
  const bus = Object.fromEntries(
    ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  )
  const argv = capped
    ? [
        "systemd-run",
        "--user",
        "--scope",
        "-q",
        "-p",
        `MemoryMax=${options.memoryMax ?? "3G"}`,
        "-p",
        "MemorySwapMax=0",
        "env",
        "-u",
        "XDG_RUNTIME_DIR",
        "-u",
        "DBUS_SESSION_BUS_ADDRESS",
        ...command,
      ]
    : command
  const fd = openSync(log, "a")
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: p.project,
    env: { ...sandboxEnv(p), ...env, ...(capped ? bus : {}) },
    detached: true,
    stdio: ["ignore", fd, fd],
  })
  child.unref()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const match = readFileSync(log, "utf8").match(ready)
    if (match) return { pid: child.pid!, match }
    if (child.exitCode !== null || !alive(child.pid!)) break
    await Bun.sleep(100)
  }
  signal(child.pid!, "SIGKILL")
  throw new Error(
    `${command.slice(0, 3).join(" ")} did not start. Last log lines (${log}):\n${readFileSync(log, "utf8").split("\n").slice(-30).join("\n")}`,
  )
}
