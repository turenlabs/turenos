export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "url"
// @ts-expect-error npm does not publish types for this internal config API.
import Config from "@npmcli/config"
// @ts-expect-error npm does not publish types for this internal config API.
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect } from "effect"

const npmPath = fileURLToPath(new URL("..", import.meta.url))

export const load = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const config = new Config({
        npmPath,
        cwd: dir,
        env: { ...process.env },
        argv: [process.execPath, process.execPath],
        execPath: process.execPath,
        platform: process.platform,
        definitions,
        flatten,
        nerfDarts,
        shorthands,
        warn: false,
      })
      // Flattening `omit` makes `@npmcli/config` write `process.env.NODE_ENV = "production"` on the
      // real process env, not the copy handed to it above, whenever the resolved config omits dev
      // dependencies. Asking npm for a registry URL must not put the host process into production
      // mode: this one reaches far, since the secret vault only offers its ephemeral test key while
      // NODE_ENV is "test", so a single config read turns every later vault build into a hard error.
      const nodeEnv = process.env.NODE_ENV
      try {
        await config.load()
        return config.flat as Record<string, unknown>
      } finally {
        if (nodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = nodeEnv
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))

export const registry = (dir: string) =>
  load(dir).pipe(
    Effect.map((config) => {
      const registry = typeof config.registry === "string" ? config.registry : "https://registry.npmjs.org"
      return registry.endsWith("/") ? registry.slice(0, -1) : registry
    }),
  )
