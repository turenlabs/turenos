export * as GitLauncher from "./git-launcher"

import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { Effect, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { AppProcess } from "./process"

type Launch = { command: string; env: NodeJS.ProcessEnv }
type Resolution = {
  selection: string
  link: string | undefined
  environment: string
  expiresAt: number
  launch: Launch | undefined
}

export const make = Effect.fnUntraced(function* (proc: AppProcess.Interface) {
  const lock = yield* Semaphore.make(1)
  let cached: Resolution | undefined
  const query = (cwd: string, env: NodeJS.ProcessEnv, binary: string, args: string[]) =>
    proc
      .run(ChildProcess.make(binary, args, { cwd, env, stdin: "ignore" }), {
        timeout: "1 second",
        maxOutputBytes: 64 * 1024,
        maxErrorBytes: 4096,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && !result.stdoutTruncated && !result.stderr.length
            ? result.stdout.toString("utf8")
            : undefined,
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      )

  return Effect.fnUntraced(function* (cwd: string, env: NodeJS.ProcessEnv = process.env) {
    if (process.platform !== "darwin" || typeof Bun === "undefined") return
    const environment = { ...env }
    if (
      !environment.PATH ||
      environment.PATH.split(path.delimiter).some((entry) => !path.isAbsolute(entry)) ||
      Bun.which("git", { PATH: environment.PATH }) !== "/usr/bin/git" ||
      Object.keys(environment).some((key) => key.startsWith("xcrun_")) ||
      (environment.DEVELOPER_DIR !== undefined && !path.isAbsolute(environment.DEVELOPER_DIR)) ||
      [environment.SDKROOT, environment.TOOLCHAINS].some((value) => value?.includes("/") && !path.isAbsolute(value))
    )
      return

    const key = createHash("sha256").update(JSON.stringify(environment)).digest("hex")
    const link =
      environment.DEVELOPER_DIR === undefined
        ? yield* Effect.promise(() => realpath("/var/db/xcode_select_link").catch(() => undefined))
        : undefined
    // Use the system link only after xcode-select reports the same directory.
    if (link && cached?.link === link && reusable(cached, key)) return cached.launch

    const selection = parsePath(yield* query(cwd, environment, "/usr/bin/xcode-select", ["--print-path"]))
    if (!selection) return
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (cached?.selection === selection && reusable(cached, key)) {
          cached.link = link === selection ? link : undefined
          return cached.launch
        }
        // Pin both queries to the same developer directory even if selection changes between them.
        const selected = { ...environment, DEVELOPER_DIR: selection }
        const [tool, inherited] = yield* Effect.all(
          [
            query(cwd, selected, "/usr/bin/xcrun", ["--find", "git"]),
            query(cwd, selected, "/usr/bin/xcrun", ["/usr/bin/env", "-0"]),
          ],
          { concurrency: 2 },
        )
        const command = parsePath(tool)
        const launchEnv = parseEnvironment(inherited)
        const launch =
          command && path.basename(command) === "git" && Bun.which(command) && launchEnv
            ? { command, env: launchEnv }
            : undefined
        if (launch) {
          // The pin is for lookup only. A clean filter sees the caller's original override.
          if (environment.DEVELOPER_DIR === undefined) delete launch.env.DEVELOPER_DIR
          else launch.env.DEVELOPER_DIR = environment.DEVELOPER_DIR
        }
        cached = {
          selection,
          link: link === selection ? link : undefined,
          environment: key,
          expiresAt: Date.now() + (launch ? 60_000 : 2_000),
          launch,
        }
        return launch
      }),
    )
  })
})

function reusable(entry: Resolution, key: string) {
  return entry.environment === key && entry.expiresAt > Date.now() && (!entry.launch || Bun.which(entry.launch.command))
}

function parsePath(output: string | undefined) {
  if (!output?.endsWith("\n")) return
  const value = output.slice(0, -1)
  if (path.isAbsolute(value) && !/[\r\n\0\ufffd]/.test(value)) return value
}

function parseEnvironment(output: string | undefined) {
  if (!output?.endsWith("\0") || output.includes("\ufffd")) return
  const entries = output
    .slice(0, -1)
    .split("\0")
    .map((entry) => {
      const split = entry.indexOf("=")
      return split > 0 ? ([entry.slice(0, split), entry.slice(split + 1)] as const) : undefined
    })
  const values = entries.filter((entry) => entry !== undefined)
  if (values.length === entries.length && new Set(values.map((entry) => entry[0])).size === values.length) {
    return Object.fromEntries(values)
  }
}
