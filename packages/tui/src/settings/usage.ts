import { array, numeric, object, optional, string } from "../response-validation"
import { label } from "../state"
import { color } from "../theme"
import { directory, section, trail, type SettingsContext } from "./shared"

export function usage(ctx: SettingsContext) {
  return section(
    ctx,
    trail("Usage and limits"),
    () => ctx.connection.api("/provider/usage", { directory: directory(ctx) }).then(object),
    (result, picker) => {
      picker.text.content = usageText(result)
      picker.text.fg = color.text
      picker.set([{ name: "Refresh", run: () => usage(ctx) }])
    },
    "refresh",
  )
}

function usageText(result: Record<string, unknown>) {
  const providers = array(result.providers, 512).map((value) => {
    const item = object(value)
    const tokens = object(item.tokens)
    const total = ["input", "output", "reasoning"].reduce((sum, key) => sum + numeric(tokens[key]), 0)
    return `${label(string(item.providerID, 256), 40)}: ${numeric(item.turns)} turns · ${Math.round(total / 1000)}k tokens · $${numeric(item.cost).toFixed(2)}`
  })
  const quotas = array(result.quotas, 512).flatMap((value) => {
    const quota = object(value)
    optional(quota.detail, string)
    optional(quota.plan, string)
    return [
      `${label(string(quota.providerID, 256), 40)}${quota.plan ? ` (${label(quota.plan as string, 40)})` : ""}: ${label(string(quota.status, 32))}${quota.detail ? ` · ${label(quota.detail as string, 200)}` : ""}`,
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
