// IMPORTANT: the XDG_* assignments below must happen before anything imports from src/.
// `src/global.ts` resolves ~/.local/share/forge, ~/.cache/forge, ~/.config/forge and
// ~/.local/state/forge through xdg-basedir at module-import time, and xdg-basedir reads
// the env once at *its* import time, so a later assignment (or importing xdg-basedir
// here) has no effect. Do not import from src/ or from xdg-basedir above this block.
//
// Without this isolation every core test process shares the developer's real TurenOS
// directories. `test/models.test.ts` deletes and rewrites <cache>/forge/models.json
// around every test, so any second process touching the same file — another `bun test`
// run, turbo running package suites in parallel, or the developer's own TurenOS install —
// makes the "ModelsDev Service" suite fail intermittently, and the suite silently
// destroys the user's real model catalogue on the way through.
import os from "os"
import path from "path"
import fs from "fs/promises"
import { rmSync } from "fs"

// Mirrors xdg-basedir's rule (XDG_CACHE_HOME, else ~/.cache) so we can keep the shared
// binary cache reachable after repointing XDG_CACHE_HOME at the isolated directory.
const realCache = process.env["XDG_CACHE_HOME"] || path.join(os.homedir(), ".cache")
const sharedBin = path.join(realCache, "forge", "bin")

const root = path.join(os.tmpdir(), `forge-core-test-${process.pid}`)
await fs.mkdir(root, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(root, "share")
process.env["XDG_CACHE_HOME"] = path.join(root, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(root, "config")
process.env["XDG_STATE_HOME"] = path.join(root, "state")

// `Global.Path.bin` (<cache>/forge/bin) holds the on-demand ripgrep download, and
// `util/which` searches PATH. Keeping the shared copy on PATH means isolating the cache
// directory does not turn every ripgrep-backed test into a fresh 4MB GitHub download.
process.env["PATH"] = process.env["PATH"] ? `${process.env["PATH"]}${path.delimiter}${sharedBin}` : sharedBin

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup: a leftover temp directory must never fail a test run.
  }
})

process.env.FORGE_DB = ":memory:"
process.env.FORGE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.FORGE_DISABLE_MODELS_FETCH = "true"
