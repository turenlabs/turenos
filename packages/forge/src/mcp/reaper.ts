import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

/**
 * Startup sweep for `forge security-mcp` children stranded by a previous run.
 *
 * Children spawned by builds that predate the orphan watchdog in
 * `src/security/mcp/server.ts` never notice their parent dying, so a machine
 * can accumulate them across restarts. This clears that backlog; it is not the
 * primary defence, and once every running child self-terminates it should
 * find nothing.
 *
 * Scoping is deliberately paranoid — the same machine runs unrelated MCP
 * servers, and a live forge instance's own children must survive untouched.
 * See `isStrandedSecurityMcp` for the exact predicate.
 */

/** The final argv entry of the command we spawn. Nothing else is considered. */
const SECURITY_MCP_ARG = "security-mcp"

/**
 * Accepted executables, matched against the end of the command line with the
 * trailing `security-mcp` argument removed. "Ends with" rather than "contains"
 * is what keeps this from matching an unrelated process that merely mentions
 * forge somewhere in its arguments.
 */
const FORGE_ENTRYPOINTS = [
  "/forge-cli", // compatibility executable in a packaged TurenOS app
  "/forge-cli.exe",
  "/forge", // installed binary on PATH
  "/forge.exe",
  "/packages/forge/src/index.ts", // repo dev server: bun run .../packages/forge/src/index.ts
  "/forge/dist/node/index.js", // bundled node build
]

export interface ProcessEntry {
  pid: number
  ppid: number
  command: string
}

/** Parse `ps -xo pid=,ppid=,command=` output. Malformed rows are dropped. */
export function parseProcessList(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number.parseInt(match[1]!, 10)
    const ppid = Number.parseInt(match[2]!, 10)
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue
    entries.push({ pid, ppid, command: match[3]! })
  }
  return entries
}

/**
 * True only for a security MCP child of *this* application that has already
 * lost its parent. Every clause is load-bearing:
 *
 *  - `ppid === 1` means the process was reparented to init, so whoever spawned
 *    it is provably gone. A live forge instance's own children keep a real
 *    parent pid and are therefore never candidates.
 *  - the command line must *end* with the literal `security-mcp` argument.
 *  - the text preceding that argument must end with a known forge entry point,
 *    so the process has to have been started from a forge binary or the forge
 *    package entry, not merely reference one.
 *  - `pid !== self` so a sweep can never target its own caller.
 */
export function isStrandedSecurityMcp(entry: ProcessEntry, self: number): boolean {
  if (entry.pid === self) return false
  if (entry.ppid !== 1) return false
  const command = entry.command.trimEnd()
  if (!command.endsWith(SECURITY_MCP_ARG)) return false
  const executable = command.slice(0, command.length - SECURITY_MCP_ARG.length).trimEnd()
  if (executable.length === command.length) return false // no argument separator
  return FORGE_ENTRYPOINTS.some((entrypoint) => executable.endsWith(entrypoint))
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Kill stranded security MCP children left over from previous runs.
 * Returns the pids that were signalled. Never throws.
 */
export const reapStrandedSecurityMcp = Effect.fnUntraced(
  function* () {
    if (process.platform === "win32") return [] as number[]
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // `-x` (rather than `-ax`) keeps the listing to the current user, so the
    // sweep can never reach another account's processes.
    const handle = yield* spawner.spawn(
      ChildProcess.make("/bin/ps", ["-xo", "pid=,ppid=,command="], { stdin: "ignore" }),
    )
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
    yield* handle.exitCode

    const targets = parseProcessList(text).filter((entry) => isStrandedSecurityMcp(entry, process.pid))
    if (targets.length === 0) return [] as number[]

    for (const target of targets) {
      try {
        process.kill(target.pid, "SIGTERM")
      } catch {}
    }
    yield* Effect.sleep("2 seconds")
    for (const target of targets) {
      if (!alive(target.pid)) continue
      try {
        process.kill(target.pid, "SIGKILL")
      } catch {}
    }
    yield* Effect.logInfo("reaped stranded security MCP children", { pids: targets.map((target) => target.pid) })
    return targets.map((target) => target.pid)
  },
  Effect.scoped,
  Effect.catchCause(() => Effect.succeed([] as number[])),
)

export * as McpReaper from "./reaper"
