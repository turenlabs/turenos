import type { Argv, InferredOptionTypes } from "yargs"
import { ConfigV1 } from "@turenlabs/core/v1/config/config"
import { Flag } from "@turenlabs/core/flag/flag"
import type { Config } from "@/config/config"
import { isLoopbackHostname } from "@/server/shared/local-request"
import { fail } from "./effect-cmd"
import { Effect } from "effect"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: forge.local)",
    default: "forge.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
  insecure: {
    type: "boolean" as const,
    describe: "allow listening on a non-loopback interface without FORGE_SERVER_PASSWORD",
    default: false,
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

export function hasArg(name: string) {
  return networkArgs().some((arg) => arg === name || arg.startsWith(name + "="))
}

function hasBooleanArg(name: string) {
  return networkArgs().some(
    (arg) => arg === name || arg === name + "=true" || arg === name + "=false" || arg === "--no-" + name.slice(2),
  )
}

function networkArgs() {
  const separator = process.argv.indexOf("--")
  return process.argv.slice(2, separator === -1 ? undefined : separator)
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  const resolved = resolveNetworkOptionsNoConfig(args, config)
  if (!Flag.FORGE_SERVER_PASSWORD && !args.insecure && !isLoopbackHostname(resolved.hostname)) {
    return yield* fail(
      `Refusing to listen on ${resolved.hostname} without FORGE_SERVER_PASSWORD. ` +
        "Set FORGE_SERVER_PASSWORD, bind a loopback hostname, or pass --insecure to override.",
    )
  }
  return resolved
})

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: ConfigV1.Info) {
  const portExplicitlySet = hasArg("--port")
  const hostnameExplicitlySet = hasArg("--hostname")
  const mdnsExplicitlySet = hasBooleanArg("--mdns")
  const mdnsDomainExplicitlySet = hasArg("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  return { hostname, port, mdns, mdnsDomain, cors, insecure: args.insecure }
}
