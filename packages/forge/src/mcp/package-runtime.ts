import path from "node:path"
import { Effect } from "effect"
import { Global } from "@turenlabs/core/global"
import { McpConfig } from "./config"
import { McpRuntime } from "./runtime"
import { ensureUvBinary } from "./uv-runtime"

type Recipe = {
  readonly package: string
  readonly version: string
  readonly command: string
  readonly cutoff: string
  readonly args: readonly string[]
  readonly secrets: readonly { readonly name: string; readonly secret: string }[]
  readonly environment: (settings: Readonly<Record<string, string>>) => Readonly<Record<string, string>> | undefined
}

const recipes: Readonly<Record<string, Recipe>> = {
  "automox-local": {
    package: "automox-mcp",
    version: "2.2.9",
    command: "automox-mcp",
    cutoff: "2026-07-22T01:44:15Z",
    args: [],
    secrets: [
      { name: "AUTOMOX_API_KEY", secret: "AUTOMOX_API_KEY" },
      { name: "AUTOMOX_ACCOUNT_UUID", secret: "AUTOMOX_ACCOUNT_UUID" },
    ],
    environment: (settings) => ({
      AUTOMOX_ORG_ID: settings.organizationId,
      AUTOMOX_MCP_READ_ONLY: "true",
      AUTOMOX_MCP_SANITIZE_RESPONSES: "true",
      AUTOMOX_MCP_SKIP_DOTENV: "1",
    }),
  },
  "crowdstrike-falcon": {
    package: "falcon-mcp",
    version: "0.16.1",
    command: "falcon-mcp",
    cutoff: "2026-08-26T00:00:00Z",
    args: ["--read-only"],
    secrets: [
      { name: "FALCON_CLIENT_ID", secret: "FALCON_CLIENT_ID" },
      { name: "FALCON_CLIENT_SECRET", secret: "FALCON_CLIENT_SECRET" },
    ],
    environment: (settings) => falconEnvironment(settings.baseUrl),
  },
}

export function managedPackage(id: string) {
  return Object.hasOwn(recipes, id)
}

export const configuration = Effect.fn("McpPackageRuntime.configuration")(function* (
  id: string,
  settings: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string | undefined>>,
  dependencies?: { readonly ensureUv?: () => Promise<string | undefined> },
) {
  const recipe = recipes[id]
  if (!recipe) return undefined
  const environment = recipe.environment(settings)
  if (!environment) return undefined
  const executable = yield* Effect.promise(() => (dependencies?.ensureUv ?? ensureUvBinary)())
  if (!executable) return undefined
  const args = recipeArguments(recipe)
  const entry: McpConfig.Local = {
    type: "local",
    command: [executable, ...args],
    enabled: true,
    timeout: 120_000,
  }
  return McpRuntime.attach(
    entry,
    {
      backend: "package",
      executable,
      args,
      secrets: [...recipe.secrets],
      environment: {
        ...packageEnvironment(),
        ...environment,
        UV_CACHE_DIR: path.join(Global.Path.cache, "mcp-packages", "uv-cache"),
        UV_PYTHON_INSTALL_DIR: path.join(Global.Path.cache, "mcp-packages", "python"),
        UV_TOOL_DIR: path.join(Global.Path.cache, "mcp-packages", "tools"),
        UV_NO_PROGRESS: "1",
      },
    },
    secrets,
  )
})

function packageEnvironment(): Readonly<Record<string, string>> {
  if (process.platform !== "win32") return { PATH: "/usr/bin:/bin" }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  return { PATH: path.join(systemRoot, "System32"), SYSTEMROOT: systemRoot }
}

function falconEnvironment(value: string | undefined) {
  const baseUrl = value || "https://api.crowdstrike.com"
  if (
    !new Set([
      "https://api.crowdstrike.com",
      "https://api.us-2.crowdstrike.com",
      "https://api.eu-1.crowdstrike.com",
      "https://api.laggar.gcw.crowdstrike.com",
    ]).has(baseUrl)
  ) {
    return undefined
  }
  return { FALCON_BASE_URL: baseUrl }
}

export function owns(id: string, entry: McpConfig.Info | undefined) {
  const recipe = recipes[id]
  if (!recipe || !entry) return Boolean(recipe && !entry)
  if (entry.type !== "local" || entry.timeout !== 120_000) return false
  if (
    !Object.keys(entry).every((key) => key === "type" || key === "command" || key === "enabled" || key === "timeout")
  ) {
    return false
  }
  const expected = expectedCommand(recipe)
  return entry.command.length === expected.length && entry.command.every((value, index) => value === expected[index])
}

export function matches(id: string, entry: McpConfig.Info | undefined) {
  if (!owns(id, entry) || !entry || entry.type !== "local") return owns(id, entry)
  return true
}

export function persisted(id: string, entry: McpConfig.Info, enabled: boolean): McpConfig.Info {
  if (!managedPackage(id) || entry.type !== "local") throw new TypeError(`${id} is not a managed package MCP`)
  return { type: "local", command: entry.command, enabled, timeout: entry.timeout }
}

function expectedCommand(recipe: Recipe) {
  return [
    path.join(Global.Path.bin, `uv-0.12.6${process.platform === "win32" ? ".exe" : ""}`),
    ...recipeArguments(recipe),
  ]
}

function recipeArguments(recipe: Recipe) {
  return [
    "tool",
    "run",
    "--no-config",
    "--managed-python",
    "--exclude-newer",
    recipe.cutoff,
    "--from",
    `${recipe.package}==${recipe.version}`,
    recipe.command,
    ...recipe.args,
  ]
}

export * as McpPackageRuntime from "./package-runtime"
