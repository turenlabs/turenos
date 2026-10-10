import { contextTokens } from "@turenlabs/client/context"
import { array, numeric, object, optional, string } from "../response-validation"
import { label } from "../state"
import { color } from "../theme"
import { directory, section, trail, type SettingsContext } from "./shared"

export function usage(ctx: SettingsContext) {
  return section(
    ctx,
    trail("Usage and limits"),
    () => load(ctx),
    ([result, names], picker) => {
      picker.text.content = usageText(result, names)
      picker.text.fg = color.text
      picker.set([{ name: "Refresh", description: "Fetch usage and quotas again", run: () => usage(ctx) }])
    },
    "refresh",
  )
}

/** The usage report and each provider's display name; a catalog that fails to load leaves the ids. */
async function load(ctx: SettingsContext) {
  const where = directory(ctx)
  const [result, catalog] = await Promise.all([
    ctx.connection.api("/provider/usage", { directory: where }).then(object),
    ctx.connection.providers.list(where).catch(() => undefined),
  ])
  return [result, new Map(catalog?.providers.map((provider) => [provider.id, provider.name] as const))] as const
}

function usageText(result: Record<string, unknown>, names: Map<string, string>) {
  const named = (id: string) => label(names.get(id) ?? id, 40)
  const providers = array(result.providers, 512).map((value) => {
    const item = object(value)
    const tokens = object(item.tokens)
    // Cached prompt tokens count too, as in the desktop's usage page; a report without them counts none.
    const cache = tokens.cache === undefined ? { read: 0, write: 0 } : object(tokens.cache)
    const total = contextTokens({
      input: numeric(tokens.input),
      output: numeric(tokens.output),
      reasoning: numeric(tokens.reasoning),
      cache: { read: numeric(cache.read), write: numeric(cache.write) },
    })
    return `${named(string(item.providerID, 256))}: ${numeric(item.turns)} turns · ${Math.round(total / 1000)}k tokens · $${numeric(item.cost).toFixed(2)}`
  })
  const quotas = array(result.quotas, 512).flatMap((value) => {
    const quota = object(value)
    optional(quota.detail, string)
    optional(quota.plan, string)
    return [
      `${named(string(quota.providerID, 256))}${quota.plan ? ` (${label(quota.plan as string, 40)})` : ""}: ${label(string(quota.status, 32))}${quota.detail ? ` · ${label(quota.detail as string, 200)}` : ""}`,
      ...array(quota.windows, 32).map((value) => {
        const window = object(value)
        const reset = typeof window.resetAt === "number" ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ""
        return `  ${label(string(window.label, 100), 40)}: ${Math.round(numeric(window.usedPercent))}% used${reset}`
      }),
    ]
  })
  return [
    "LAST 7 DAYS",
    ...(providers.length ? providers : ["No usage recorded."]),
    "",
    "PLAN QUOTAS",
    ...(quotas.length ? quotas : ["No provider reports quotas."]),
  ].join("\n")
}
