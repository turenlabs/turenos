import { invalid, isRecord } from "../response-validation"
import type { ProviderRequest } from "./request"
import { array, defaultModels, id, modelStatus, optionalLabel, record, releaseDate, text } from "./validation"

type CatalogModel = {
  providerID: string
  id: string
  name: string
  providerName: string
  variants?: string[]
  /** The published context window in tokens, when the provider states one. */
  context?: number
  /** The release day as `YYYY-MM-DD`, when the server states a valid one. */
  release?: string
  /** The model family; the newest release of each family counts as the latest. */
  family?: string
  /** Only a known lifecycle status survives; deprecated models are left out of the picker. */
  status?: "alpha" | "beta" | "active" | "deprecated"
}

export async function catalog(request: ProviderRequest, selected: string, signal?: AbortSignal) {
  const result = record(await request("/provider", { directory: selected, signal }))
  const connected = new Set(array(result.connected, 1024).map((value) => id(value)))
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  let count = 0
  const providers = array(result.all, 1024).map((value) => {
    const item = record(value)
    const provider = {
      id: id(item.id),
      name: text(item.name, "provider name"),
      connected: connected.has(id(item.id)),
    }
    if (seen.has(provider.id)) invalid("duplicate provider ID")
    seen.add(provider.id)
    for (const [key, value] of Object.entries(record(item.models))) {
      if (++count > 10000) invalid("more than 10,000 models")
      const model = catalogModel(key, value, provider)
      if (provider.connected) models.push(model)
    }
    return provider
  })
  if ([...connected].some((value) => !seen.has(value))) invalid("unknown connected provider")
  return { providers, models, defaults: defaultModels(result.default) }
}

function catalogModel(key: string, value: unknown, provider: { id: string; name: string }): CatalogModel {
  const model = record(value)
  const modelID = id(model.id, true)
  if (id(key, true) !== modelID || id(model.providerID) !== provider.id) invalid("model identity")
  const name = text(model.name, "model name")
  // The public provider catalog already removes disabled variants. Only names leave this adapter.
  const variants =
    model.variants === undefined
      ? undefined
      : array(Object.keys(record(model.variants)), 128).map((value) => id(value, true))
  const context = isRecord(model.limit) ? model.limit.context : undefined
  const release = releaseDate(model.release_date)
  const family = optionalLabel(model.family)
  const status = modelStatus(model.status)
  return {
    providerID: provider.id,
    id: modelID,
    name,
    providerName: provider.name,
    ...(variants && variants.length > 0 ? { variants } : {}),
    ...(release ? { release } : {}),
    ...(family ? { family } : {}),
    ...(status ? { status } : {}),
    ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? { context } : {}),
  }
}

export async function globalProviderIDs(request: ProviderRequest, signal?: AbortSignal) {
  // Keep the full config inside this boundary; only validated IDs leave it.
  const config = record(await request("/global/config", { secret: true, signal }))
  const configured = ["provider", "providers"].flatMap((field) => {
    const keys = config[field] === undefined ? [] : Object.keys(record(config[field]))
    return array(keys, 1024).map((value) => id(value))
  })
  const disabled = config.disabled_providers === undefined ? [] : array(config.disabled_providers, 1024)
  return new Set([...configured, ...disabled.map((value) => id(value))])
}
