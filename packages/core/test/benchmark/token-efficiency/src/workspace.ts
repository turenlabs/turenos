import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = path.resolve(HERE, "..", "fixture")
export const BENCH_DIR = path.resolve(HERE, "..")

/**
 * Scratch root for per-run workspaces and TurenOS scratch databases.
 *
 * Everything the benchmark writes at runtime goes under here, never into the
 * repo and never into the user's forge data directory.
 */
export function scratchRoot(): string {
  const configured = process.env["TOKEN_BENCH_SCRATCH"]
  const root = configured && configured.length > 0 ? configured : path.join(os.tmpdir(), "turen-token-bench")
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Hard guard: refuse to run if a TurenOS scratch DB path could ever resolve onto
 * the user's real forge database. This is a correctness gate, not a nicety —
 * pointing FORGE_DB at the real database would let a benchmark run mutate real
 * sessions.
 */
export function assertSafeForgeDb(dbPath: string): void {
  if (!path.isAbsolute(dbPath)) {
    throw new Error(`FORGE_DB for the benchmark must be an absolute path, got: ${dbPath}`)
  }
  const home = os.homedir()
  const forbidden = [
    path.join(home, ".local", "share", "forge"),
    path.join(home, "Library", "Application Support", "forge"),
    process.env["XDG_DATA_HOME"] ? path.join(process.env["XDG_DATA_HOME"], "forge") : undefined,
  ].filter((entry): entry is string => Boolean(entry))
  for (const dir of forbidden) {
    const rel = path.relative(dir, dbPath)
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      throw new Error(`refusing to point FORGE_DB inside the real forge data directory: ${dbPath}`)
    }
  }
  const rel = path.relative(scratchRoot(), dbPath)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`benchmark FORGE_DB must live under the scratch root ${scratchRoot()}, got: ${dbPath}`)
  }
}

/**
 * Materialise a pristine copy of the fixture repo for one run.
 *
 * Two things matter here:
 *  1. The copy lives OUTSIDE the forge repo. If the fixture were used in place,
 *     every harness would walk up and discover the real repo's git root,
 *     AGENTS.md/CLAUDE.md and config — which would silently contaminate the
 *     measurement.
 *  2. It is `git init`-ed and committed, so all three harnesses see the same
 *     "clean checkout" shape and none of them refuses to run or reports a
 *     dirty tree.
 */
export function materializeWorkspace(runId: string, key: string): string {
  const dir = path.join(scratchRoot(), runId, key)
  if (existsSync(dir)) throw new Error(`workspace already exists (run keys must be unique): ${dir}`)
  mkdirSync(dir, { recursive: true })
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  git(dir, ["init", "-q"])
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "-m", "fixture"])
  return dir
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, stdio: "ignore" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`)
}
