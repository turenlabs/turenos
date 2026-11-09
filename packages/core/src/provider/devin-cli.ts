export * as DevinCLI from "./devin-cli"

import { ProviderV2 } from "../provider"
import { which } from "../util/which"

export const ID = ProviderV2.ID.make("devin-cli")
export const NAME = "Devin CLI (local)"
export const API_URL = "local://devin-cli"
export const DEFAULT_EXECUTABLE = "devin"
export const EXECUTABLE_KEY = "executable"

export type ProbeResult =
  | { readonly status: "installed"; readonly executable: string }
  | { readonly status: "unavailable" }

export function resolveExecutable(value: unknown): string | undefined {
  const requested = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_EXECUTABLE
  return which(requested) ?? undefined
}

/** Installation does not verify login. Discovery never runs Devin or reads credentials. */
export async function probe(value?: unknown): Promise<ProbeResult> {
  const executable = resolveExecutable(value)
  return executable ? { status: "installed", executable } : { status: "unavailable" }
}

export type ModelDefinition = {
  readonly id: string
  readonly apiID: string
  readonly name: string
  readonly context: number
  readonly output: number
}

// The JSON model-list format is not verified. Use the user's Devin default instead.
export const MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "default",
    apiID: "default",
    name: "Devin default",
    // Conservative offline fallbacks, not verified Devin model limits.
    context: 32_768,
    output: 8_192,
  },
]
