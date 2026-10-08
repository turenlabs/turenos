// Model-picker rules shared by the desktop app and the terminal client. Inputs are typed
// structurally so both the SDK types and the client types fit; keep this file framework-free.

export const popularProviders = [
  "anthropic",
  "claude-code",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

const LATEST_WINDOW = 180 * 24 * 60 * 60 * 1000
const RELEASE_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/

export const modelKey = (model: { providerID: string; id: string }) => `${model.providerID}:${model.id}`

/** Popular providers first in `popularProviders` order, then the rest alphabetically by name. */
export function compareProviders(a: { id: string; name: string }, b: { id: string; name: string }) {
  const aIndex = popularProviders.indexOf(a.id)
  const bIndex = popularProviders.indexOf(b.id)
  if (aIndex >= 0 && bIndex < 0) return -1
  if (aIndex < 0 && bIndex >= 0) return 1
  if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex
  return a.name.localeCompare(b.name)
}

/** `category` is the provider id; the provider name comes from the first item. */
export const sortModelGroups = <T extends { category: string; items: readonly { provider: { name: string } }[] }>(
  groups: readonly T[],
) =>
  groups.toSorted((a, b) =>
    compareProviders(
      { id: a.category, name: a.items[0].provider.name },
      { id: b.category, name: b.items[0].provider.name },
    ),
  )

export const normalizeModelSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)
  if (!search) return true

  const compactSearch = compactModelSearch(query)
  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}

export const cleanModelName = (name: string) => ({
  name: name.replace("(latest)", "").trim(),
  latest: name.includes("(latest)"),
})

/** Newest model per provider and family among those released within 180 days of `now` (either side, exclusive). */
export function latestModels(
  models: readonly { id: string; providerID: string; family?: string; release_date?: string }[],
  now: number,
) {
  const newest = new Map<string, (typeof models)[number]>()
  models.forEach((model) => {
    if (model.family === undefined || !(Math.abs(releaseTime(model.release_date) - now) < LATEST_WINDOW)) return
    const key = `${model.providerID}\u0000${model.family}`
    const current = newest.get(key)
    // String comparison on purpose; ties keep the first model.
    if (!current || model.release_date! > current.release_date!) newest.set(key, model)
  })
  return new Set([...newest.values()].map(modelKey))
}

/** Explicit override wins, then the latest set; otherwise only models without a valid release date show. */
export function modelVisible(
  model: { id: string; providerID: string; release_date?: string },
  latest: ReadonlySet<string>,
  override?: ReadonlyMap<string, boolean | undefined>,
) {
  const key = modelKey(model)
  const state = override?.get(key)
  if (state !== undefined) return state
  if (latest.has(key)) return true
  return Number.isNaN(releaseTime(model.release_date))
}

export const withoutDeprecated = <T extends { status?: string }>(models: Readonly<Record<string, T>>) =>
  Object.fromEntries(Object.entries(models).filter(([, model]) => model.status !== "deprecated"))

/** Walks connected providers in order: the configured default if usable, else the provider's first model. */
export function defaultModel(
  providers: ReadonlyMap<string, { models: Readonly<Record<string, { id: string }>> }>,
  defaults: Readonly<Record<string, string | undefined>>,
  connected: Iterable<string>,
  available: (model: { providerID: string; modelID: string }) => boolean = () => true,
) {
  for (const providerID of connected) {
    const provider = providers.get(providerID)
    if (!provider) continue
    const configured = defaults[providerID]
    if (configured && provider.models[configured] && available({ providerID, modelID: configured })) {
      return { providerID, modelID: configured }
    }
    const first = Object.values(provider.models)[0]
    if (first && available({ providerID, modelID: first.id })) return { providerID, modelID: first.id }
  }
}

/** Puts `model` first, drops its earlier entry, and keeps at most `limit` models. */
export const pushRecent = <T extends { providerID: string; modelID: string }>(
  list: readonly T[],
  model: T,
  limit = 5,
) =>
  [model, ...list]
    .filter((item, index, all) => all.findIndex((other) => sameModel(other, item)) === index)
    .slice(0, limit)

const sameModel = (a: { providerID: string; modelID: string }, b: { providerID: string; modelID: string }) =>
  a.providerID === b.providerID && a.modelID === b.modelID

// Date-only values are local midnight, as the app's ISO parser read them; NaN when invalid.
function releaseTime(value?: string) {
  if (!value) return NaN
  const match = RELEASE_DATE.exec(value)
  if (!match) return Date.parse(value)
  const month = Number(match[2] ?? 1) - 1
  const day = Number(match[3] ?? 1)
  const date = new Date(Number(match[1]), month, day)
  return date.getMonth() === month && date.getDate() === day ? date.getTime() : NaN
}
