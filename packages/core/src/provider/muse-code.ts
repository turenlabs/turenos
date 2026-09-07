export * as MuseCodeCLI from "./muse-code"

import { ProviderV2 } from "../provider"
import { which } from "../util/which"

export const ID = ProviderV2.ID.make("muse-code")
export const NAME = "Muse Code (local)"
export const API_URL = "local://muse-code"
export const NPM = "muse-code-cli"
export const DEFAULT_EXECUTABLE = "muse"
export const CATALOG_PROVIDER = "meta"
export const EXECUTABLE_KEY = "executable"
export const EFFORT_KEY = "effort"

export type ProbeResult =
  | { readonly status: "installed"; readonly executable: string }
  | { readonly status: "unavailable" }

export function resolveExecutable(value: unknown): string | undefined {
  const requested = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_EXECUTABLE
  return which(requested) ?? undefined
}

/**
 * Installation discovery only: Muse has no auth-status command. Installed does
 * not mean signed in; the first model request verifies login. Never read local
 * credentials or spend a subscription turn to populate the catalog.
 */
export async function probe(value?: unknown): Promise<ProbeResult> {
  const executable = resolveExecutable(value)
  return executable ? { status: "installed", executable } : { status: "unavailable" }
}

// `none` appears in CLI help but is rejected by Meta, so do not offer it.
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const
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

/** Shared by the v2 catalog and legacy composer snapshot. */
export const MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "muse-spark-1.3",
    apiID: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    family: "muse-spark",
    // Conservative offline fallbacks, not a claim about the upstream window.
    context: 128_000,
    output: 16_000,
    efforts: EFFORT_LEVELS,
  },
]

/** Callers pass only the exact Meta model's published limits, never an alias. */
export const windowFor = (item: ModelDefinition, published?: Window): Window =>
  published && published.context > 0 && published.output > 0
    ? { context: published.context, output: published.output }
    : { context: item.context, output: item.output }
