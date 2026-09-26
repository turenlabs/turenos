import path from "node:path"
import { existsSync } from "node:fs"

// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
export function git(cwd: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

// Git's view of the tree: tracked plus new, unignored files, so ignored generated output never counts. -z keeps
// non-ASCII names unquoted, and a tracked file deleted from disk is dropped rather than read later.
export function listed(cwd: string, ...pathspecs: string[]): string[] {
  return [
    ...new Set(
      (git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspecs) ?? "").split("\0"),
    ),
  ].filter((file) => file.length > 0 && existsSync(path.join(cwd, file)))
}
