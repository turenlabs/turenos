import path from "path"

export const FORGE_CLI_COMMAND = "forge"

type Runtime = {
  env: Record<string, string | undefined>
  execPath: string
  argv: string[]
}

export function resolvePtyCommand(
  command: string | undefined,
  args: string[] | undefined,
  cwd?: string,
  runtime: Runtime = { env: process.env, execPath: process.execPath, argv: process.argv },
) {
  if (command !== FORGE_CLI_COMMAND) return { command, args }

  const configured = runtime.env.FORGE_CLI_COMMAND?.trim()
  const entry = runtime.env.FORGE_CLI_ENTRY?.trim()
  if (configured) {
    return {
      command: configured,
      args: entry && isBunRuntime(configured) ? sourceArgs(entry, args, cwd) : args,
    }
  }

  const source = runtime.argv[1]
  if (isBunRuntime(runtime.execPath) && source && !source.startsWith("-") && isSourceEntrypoint(source)) {
    return {
      command: runtime.execPath,
      args: sourceArgs(source, args, cwd),
    }
  }

  if (isForgeBinary(runtime.execPath)) return { command: runtime.execPath, args }
  return { command: FORGE_CLI_COMMAND, args }
}

/**
 * `sourceArgs` derives the package root as `dirname(dirname(source))`, which is only
 * correct when Bun was started on a package entrypoint (`<package>/src/index.ts`).
 * Any other `argv[1]` — most importantly a `bun test` file — would be re-executed as
 * if it were the TurenOS CLI. That is how the security MCP server used to be handed a
 * test file to spawn, which then could not speak JSON-RPC and closed the transport.
 */
function isSourceEntrypoint(source: string) {
  return path.basename(source) === "index.ts" && path.basename(path.dirname(source)) === "src"
}

function sourceArgs(source: string, args: string[] | undefined, cwd: string | undefined) {
  return [
    "run",
    "--cwd",
    path.dirname(path.dirname(source)),
    "--conditions=browser",
    source,
    ...(cwd ? [cwd] : []),
    ...(args ?? []),
  ]
}

function isBunRuntime(command: string) {
  const name = path.basename(command).toLowerCase()
  return name === "bun" || name === "bun.exe"
}

function isForgeBinary(command: string) {
  const name = path.basename(command).toLowerCase()
  return name === FORGE_CLI_COMMAND || name === `${FORGE_CLI_COMMAND}.exe`
}
