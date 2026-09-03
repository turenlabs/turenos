import { accessSync, constants, statSync } from "node:fs"
import { join, posix, resolve, win32 } from "node:path"

type ForgeCliRuntime = {
  packaged: boolean
  platform: NodeJS.Platform
  resourcesPath: string
  appPath: string
  path?: string
}

export function resolveForgeCliEnv(runtime: ForgeCliRuntime, canExecute = isExecutable) {
  if (runtime.packaged) {
    return {
      FORGE_CLI_COMMAND: join(runtime.resourcesPath, runtime.platform === "win32" ? "forge-cli.exe" : "forge-cli"),
    }
  }

  return {
    FORGE_CLI_COMMAND: resolveBun(runtime.path, runtime.platform, canExecute),
    FORGE_CLI_ENTRY: resolve(runtime.appPath, "../forge/src/index.ts"),
  }
}

function resolveBun(path: string | undefined, platform: NodeJS.Platform, canExecute: (file: string) => boolean) {
  const windows = platform === "win32"
  const paths = path?.split(windows ? ";" : ":").filter(Boolean) ?? []
  const suffixes = windows ? [".exe", ".cmd", ".bat", ""] : [""]
  const api = windows ? win32 : posix
  const bun = paths
    .flatMap((directory) => suffixes.map((suffix) => api.join(directory.replace(/^"|"$/g, ""), `bun${suffix}`)))
    .find(canExecute)
  if (bun) return bun
  throw new Error("Bun was not found on PATH; start TurenOS Desktop with `bun run dev:desktop`")
}

function isExecutable(file: string) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}
