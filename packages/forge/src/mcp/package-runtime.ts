import path from "node:path"
import { Effect } from "effect"
import { Global } from "@turenlabs/core/global"
import { Extension } from "@turenlabs/schema"
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
  readonly environment: (
    settings: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string | undefined>>,
  ) => Readonly<Record<string, string>> | undefined
}

/**
 * The managed-package recipe is declared by the extension manifest itself:
 * `deployment.type: "managed"` carries the pinned package, version, dependency
 * cutoff, entry command, and environment template. Catalog policy
 * (packages/extensions/src/validate.ts) restricts managed deployments to
 * official manifests with exact pins, so the manifest is the single source of
 * truth for what executes.
 */
function recipeFor(item: Extension.Mcp): Recipe | undefined {
  const deployment = item.deployment
  if (deployment.type !== "managed") return undefined
  return {
    package: deployment.package,
    version: deployment.version,
    command: deployment.command,
    cutoff: deployment.cutoff,
    args: deployment.args ?? [],
    secrets: item.secrets.map((secret) => ({ name: String(secret.id), secret: String(secret.id) })),
    environment: (settings, secrets) => resolveEnvironment(item, deployment, settings, secrets),
  }
}

function resolveEnvironment(
  item: Extension.Mcp,
  deployment: Extract<Extension.McpDeployment, { type: "managed" }>,
  settings: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  const fields = new Map((item.configuration ?? []).map((field) => [String(field.id), field]))
  const environment: Record<string, string> = {}
  for (const [name, source] of Object.entries(deployment.environment ?? {})) {
    if (typeof source === "string") {
      environment[name] = source
      continue
    }
    if ("configuration" in source) {
      const field = fields.get(String(source.configuration))
      if (!field) return undefined
      const value = settings[String(field.id)] ?? field.default
      if (value === undefined) continue
      if (field.options && !field.options.includes(value)) return undefined
      environment[name] = value
      continue
    }
    const secret = secrets[String(source.secret)]
    if (secret === undefined) return undefined
    environment[name] = secret
  }
  return environment
}

export function managedPackage(item: Extension.Mcp) {
  return item.deployment.type === "managed"
}

export const configuration = Effect.fn("McpPackageRuntime.configuration")(function* (
  item: Extension.Mcp,
  settings: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string | undefined>>,
  dependencies?: { readonly ensureUv?: () => Promise<string | undefined> },
) {
  const recipe = recipeFor(item)
  if (!recipe) return undefined
  const environment = recipe.environment(settings, secrets)
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

export function owns(item: Extension.Mcp, entry: McpConfig.Info | undefined) {
  const recipe = recipeFor(item)
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

export function matches(item: Extension.Mcp, entry: McpConfig.Info | undefined) {
  if (!owns(item, entry) || !entry || entry.type !== "local") return owns(item, entry)
  return true
}

export function persisted(item: Extension.Mcp, entry: McpConfig.Info, enabled: boolean): McpConfig.Info {
  if (!managedPackage(item) || entry.type !== "local") {
    throw new TypeError(`${item.id} is not a managed package MCP`)
  }
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
