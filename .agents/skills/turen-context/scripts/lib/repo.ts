import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { git } from "./git"

export const VENDORED = /(^|\/)(vendor|node_modules|dist|build|third[-_]party)\//

export type Repo = ReturnType<typeof loadRepo>

// One snapshot of the repository that every rule reads: its tracked files, the instruction files among them, and the
// package scripts commands can name.
export function loadRepo(start: string) {
  const root = git(start, "rev-parse", "--show-toplevel") ?? start
  const tracked = (git(root, "ls-files", "--cached", "--others", "--exclude-standard") ?? "")
    .split("\n")
    .filter((file) => file.length > 0)
  const instructionFiles = tracked.filter((file) => /(^|\/)(AGENTS|AGENTS\.override|CLAUDE)\.md$/.test(file))
  const graded = instructionFiles.filter((file) => path.posix.basename(file) === "AGENTS.md" && !VENDORED.test(file))
  return {
    root,
    tracked,
    instructionFiles,
    graded,
    vendored: instructionFiles.filter((file) => VENDORED.test(file)),
    texts: new Map(graded.map((file) => [file, readFileSync(path.join(root, file), "utf8")])),
    scripts: packageScripts(root, tracked),
  }
}

// Bytes Codex loads for a session in this file's folder: every AGENTS.md (or AGENTS.override.md) from the root down.
export function chainBytes(repo: Repo, file: string) {
  return [path.posix.dirname(file), ...ancestorDirs(path.posix.dirname(file))]
    .map((dir) => {
      const override = dir === "." ? "AGENTS.override.md" : `${dir}/AGENTS.override.md`
      const regular = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`
      const chosen = [override, regular].find((candidate) => existsSync(path.join(repo.root, candidate)))
      return chosen === undefined ? 0 : Buffer.byteLength(readFileSync(path.join(repo.root, chosen)))
    })
    .reduce((sum, bytes) => sum + bytes, 0)
}

// The graded AGENTS.md files above this one, nearest first.
export function ancestors(repo: Repo, file: string) {
  return ancestorDirs(path.posix.dirname(file))
    .map((dir) => (dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`))
    .filter((candidate) => repo.texts.has(candidate))
}

// Folders above dir, nearest first, ending with the repository root ".".
export function ancestorDirs(dir: string) {
  const parts = dir === "." ? [] : dir.split("/")
  return parts.map((_, index) => parts.slice(0, parts.length - 1 - index).join("/") || ".")
}

function packageScripts(root: string, tracked: string[]) {
  const manifests = tracked.filter((file) => path.posix.basename(file) === "package.json" && !VENDORED.test(file))
  return new Map(
    manifests.map((file) => {
      const parsed: unknown = JSON.parse(readFileSync(path.join(root, file), "utf8"))
      const found = typeof parsed === "object" && parsed !== null && "scripts" in parsed ? parsed.scripts : undefined
      const names = typeof found === "object" && found !== null ? Object.keys(found) : []
      return [path.posix.dirname(file), new Set(names)] as const
    }),
  )
}
