import { contextTokens, usagePercent } from "@turenlabs/client/context"
import type { Connection, Detail } from "./server"

type Message = Detail["messages"][number]

/**
 * Context occupancy of the newest provider request, as the desktop measures it: the whole prompt
 * (uncached input plus cache reads and writes) and the response appended to it. Summing messages
 * would count cached tokens once per round trip.
 */
export function contextUsage(messages: readonly Message[]) {
  const message = messages.findLast(
    (item): item is Extract<Message, { type: "assistant" }> => item.type === "assistant" && total(item) > 0,
  )
  return message && { model: message.model, total: total(message) }
}

export function meterText(usage: ReturnType<typeof contextUsage>, limit: number | undefined, short = false) {
  if (!usage) return ""
  if (!limit) return short ? `ctx ${compact(usage.total)}` : `Context ${compact(usage.total)}`
  const percent = usagePercent(usage.total, limit)
  return short ? `ctx ${percent}%` : `Context ${percent}% · ${compact(usage.total)}/${compact(limit)}`
}

/**
 * Model context windows from the server's provider catalog, loaded once per folder. `limit` answers
 * from the cache and starts a load when the folder is unknown; `loaded` repaints once it arrives.
 */
export function createContextLimits(connection: Connection, loaded: () => void) {
  const limits = new Map<string, Map<string, number>>()
  // When each folder's load started; a failed load is retried a minute later by a later render.
  const started = new Map<string, number>()
  return function limit(directory: string, model: { providerID: string; id: string }) {
    const known = limits.get(directory)
    if (known) return known.get(`${model.providerID}/${model.id}`)
    if (Date.now() - (started.get(directory) ?? 0) < 60000) return undefined
    started.set(directory, Date.now())
    void connection.providers.list(directory).then(
      (catalog) => {
        limits.set(
          directory,
          new Map(
            catalog.models.flatMap((item) => (item.context ? [[`${item.providerID}/${item.id}`, item.context]] : [])),
          ),
        )
        loaded()
      },
      () => undefined,
    )
    return undefined
  }
}

function total(message: Extract<Message, { type: "assistant" }>) {
  return message.tokens ? contextTokens(message.tokens) : 0
}

function compact(value: number) {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}
