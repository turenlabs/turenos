type Orderable = { providerID: string; id: string; name: string; release?: string }

/**
 * Connected models in picker order: the effective model's provider first, then the others in server order.
 * Inside a provider the undated aliases (which track the newest of their family) lead, then dated models,
 * newest first and ties by name.
 */
export function orderModels<T extends Orderable>(models: T[], defaults: Record<string, string>, effective: string) {
  const providers = [...new Set(models.map((model) => model.providerID))]
  const first = [effective.slice(0, effective.indexOf("/")), ...Object.keys(defaults)].find((id) =>
    providers.includes(id),
  )
  const ranked = [first, ...providers.filter((id) => id !== first)]
  return ranked.flatMap((providerID) =>
    models.filter((model) => model.providerID === providerID).toSorted(compare),
  )
}

function compare(a: Orderable, b: Orderable) {
  if (!a.release !== !b.release) return a.release ? 1 : -1
  if (!a.release || !b.release) return 0
  return b.release.localeCompare(a.release) || a.name.localeCompare(b.name)
}
