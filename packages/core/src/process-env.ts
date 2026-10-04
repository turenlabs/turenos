export * as ProcessEnv from "./process-env"

/**
 * Removes variables from `process.env`, so children spawned from it (`node:child_process` and `Bun.$` by default, or
 * an explicit `env: process.env`) don't receive them.
 *
 * This does not clear the native environment under Bun (`/proc/<pid>/environ`, or the copy a `Bun.spawn` without
 * an `env` option inherits), and calling libc `unsetenv` does not help: every spawn path in this repo reads
 * `process.env` or passes an explicit `env`, such as the terminals in `pty/pty.bun.ts`. Pass `env: process.env` to
 * `Bun.spawn` rather than relying on its default.
 */
export function remove(names: readonly string[]) {
  names.forEach((name) => delete process.env[name])
}
