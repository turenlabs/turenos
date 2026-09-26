import type { Argv } from "yargs"
import { Effect, Layer, ManagedRuntime } from "effect"
import { cmd, type WithDoubleDash } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions, type NetworkOptions } from "../network"
import { loadSecretVaultKey, selectedSource, sources } from "../secret-vault-key"
import { loadServerPassword } from "../server-password"

type ServeArgs = NetworkOptions & { "key-source"?: string }

export const ServeCommand = cmd<{}, ServeArgs>({
  command: "serve",
  builder: ((yargs: Argv) =>
    withNetworkOptions(yargs).option("key-source", {
      type: "string",
      choices: sources,
      describe: "where to load the secret vault key (defaults to FORGE_SECRET_VAULT_KEY_SOURCE)",
    })) as never,
  describe: "starts a headless forge server",
  async handler(rawArgs) {
    const args = rawArgs as unknown as WithDoubleDash<ServeArgs>
    // The key and protected password load before anything can open the database;
    // Server.listen then takes the owner lock before building its graph.
    const keySource = selectedSource(process.env, args["key-source"])
    const credentialVault = await loadSecretVaultKey(process.env, keySource)
    const password = await loadServerPassword()
    const serverAuth = password ? { password } : undefined

    // Only config is needed here. Running under AppRuntime would build the whole app graph
    // (including MCP) a second time beside the listener's own graph.
    const [{ Config }, { AppNodeBuilderV1 }, Observability, { memoMap }] = await Promise.all([
      import("@/config/config"),
      import("@/effect/app-node-builder-v1"),
      import("@turenlabs/core/observability"),
      import("@turenlabs/core/effect/memo-map"),
    ])
    const runtime = ManagedRuntime.make(Layer.provideMerge(AppNodeBuilderV1.build(Config.node), Observability.layer), {
      memoMap,
    })
    await runtime.runPromise(
      Effect.gen(function* () {
        const { Server } = yield* Effect.promise(() => import("../../server/server"))
        if (!password) {
          console.log("Warning: FORGE_SERVER_PASSWORD is not set; server is unsecured.")
        }
        const opts = yield* resolveNetworkOptions(args, password)
        const server = yield* Effect.promise(() => Server.listen({ ...opts, keySource, credentialVault, serverAuth }))
        console.log(`forge server listening on http://${server.hostname}:${server.port}`)

        yield* Effect.never
      }).pipe(Effect.withSpan("Cli.serve")),
    )
  },
})
