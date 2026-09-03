import { Flag } from "@turenlabs/core/flag/flag"
import { Effect } from "effect"
import { mkdirSync } from "fs"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.FORGE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.FORGE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `forge-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "forge")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "forge")

/**
 * Project directory for auth-mode probes. Auth mode never builds a scenario context, so
 * its requests used to carry no `x-forge-directory` at all and workspace routing fell
 * back to `process.cwd()` — meaning every mutating protected route ran against the repo
 * checkout. The visible casualty was `PATCH /config`, which rewrote the repo's own
 * `packages/forge/config.json` and stripped its trailing newline on every auth run.
 */
export const exerciseAuthDirectory = path.join(exerciseGlobalRoot, "auth-probe")
mkdirSync(exerciseAuthDirectory, { recursive: true })

const preserveExerciseDatabase = !!process.env.FORGE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.FORGE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `forge-httpapi-exercise-${process.pid}.db`)
process.env.FORGE_DB = exerciseDatabasePath
Flag.FORGE_DB = exerciseDatabasePath

export const original = {
  FORGE_SERVER_PASSWORD: Flag.FORGE_SERVER_PASSWORD,
  FORGE_SERVER_USERNAME: Flag.FORGE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
