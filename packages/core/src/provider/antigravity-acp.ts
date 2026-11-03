export * as AntigravityAcpCLI from "./antigravity-acp"

import path from "node:path"
import { ProviderV2 } from "../provider"
import { which } from "../util/which"

export const ID = ProviderV2.ID.make("antigravity-acp")
export const NAME = "Antigravity ACP (local)"
export const API_URL = "local://antigravity-acp"
export const NPM = "antigravity-acp"
export const DEFAULT_EXECUTABLE = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"
export const CATALOG_PROVIDER = "google"
export const EXECUTABLE_KEY = "executable"
export const EFFORT_KEY = "effort"
export const ENV_EXECUTABLE = "AGY_ACP_BIN"
export const EXECUTABLE_CANDIDATES = [
  "agy_acp_server.par",
  "agy_acp_server",
  "antigravity-acp",
  "agy_acp_server.exe",
] as const

export type ProbeResult =
  | { readonly status: "installed"; readonly executable: string }
  | { readonly status: "unavailable" }

export function resolveExecutable(value: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return which(value.trim(), env) ?? undefined
  }
  const envExecutable = env[ENV_EXECUTABLE]?.trim()
  if (envExecutable) {
    return which(envExecutable, env) ?? undefined
  }
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const resolved = which(candidate, env)
    if (resolved) return resolved
  }
  const home = env.HOME || env.USERPROFILE
  if (!home) return undefined
  return which(path.join(home, ".local", "opt", "agy-acp", "current", DEFAULT_EXECUTABLE), env) ?? undefined
}

/**
 * Installation discovery only: never launch `agy_acp_server` or read local OAuth
 * credentials during catalog discovery. The first model turn checks sign-in.
 */
export async function probe(value?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const executable = resolveExecutable(value, env)
  return executable ? { status: "installed", executable } : { status: "unavailable" }
}

export const EFFORT_LEVELS = ["low", "medium", "high"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export const isEffortLevel = (value: unknown): value is EffortLevel =>
  typeof value === "string" && (EFFORT_LEVELS as ReadonlyArray<string>).includes(value)

export type Window = { readonly context: number; readonly output: number }
export type ModelDefinition = Window & {
  readonly id: string
  readonly apiID: string
  readonly name: string
  readonly family: string
  readonly efforts: ReadonlyArray<EffortLevel>
}

/**
 * Shared by the v2 catalog and legacy composer snapshot. Scoped strictly to
 * Google's Gemini models exposed by the official Antigravity ACP server.
 */
export const MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "gemini-3.8-flash",
    apiID: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    family: "gemini-flash",
    context: 1_000_000,
    output: 65_536,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "gemini-4-argon",
    apiID: "gemini-4-argon",
    name: "Gemini 4 Argon",
    family: "gemini-pro",
    context: 1_000_000,
    output: 65_536,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "gemini-3.7-flash",
    apiID: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    family: "gemini-flash",
    context: 1_000_000,
    output: 65_536,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "gemini-3.6-flash",
    apiID: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    family: "gemini-flash",
    context: 1_000_000,
    output: 65_536,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "gemini-3.1-pro",
    apiID: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    family: "gemini-pro",
    context: 1_000_000,
    output: 65_536,
    efforts: ["low", "high"],
  },
  {
    id: "gemini-3-flash",
    apiID: "gemini-3-flash",
    name: "Gemini 3 Flash",
    family: "gemini-flash",
    context: 1_000_000,
    output: 65_536,
    efforts: EFFORT_LEVELS,
  },
]

export const windowFor = (item: ModelDefinition, published?: Window): Window =>
  published && published.context > 0 && published.output > 0
    ? { context: published.context, output: published.output }
    : { context: item.context, output: item.output }
