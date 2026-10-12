import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

const CLI_NAMES = ["forge", "turenos"] as const

export type CliLinkState = "linked" | "exists" | "skipped"

// Links the bundled forge binary into a user bin directory so `forge` and
// `turenos` resolve on PATH. Only manages the app's own links: a real file,
// a directory, or a symlink to an unrelated target is left alone, so a
// standalone CLI install or a user's own link is never clobbered.
export function ensureCliLinks(binDir: string, binary: string) {
  mkdirSync(binDir, { recursive: true })
  return CLI_NAMES.map((name) => ({ name, path: join(binDir, name), state: ensureLink(join(binDir, name), binary) }))
}

function ensureLink(path: string, binary: string): CliLinkState {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry && !entry.isSymbolicLink()) return "skipped"
  if (entry) {
    const target = readlinkSync(path)
    if (target === binary) return "exists"
    const resolved = isAbsolute(target) ? target : resolve(dirname(path), target)
    if (existsSync(resolved) && !resolved.includes("/Contents/Resources/forge-cli")) return "skipped"
    unlinkSync(path)
  }
  symlinkSync(binary, path)
  return "linked"
}
