import type { LoopInfo } from "./api"

export type AutomationSort = "created-desc" | "created-asc" | "name-asc" | "status" | "next-run"

export const automationSortOptions: Array<{ value: AutomationSort; label: string }> = [
  { value: "created-desc", label: "Newest" },
  { value: "created-asc", label: "Oldest" },
  { value: "name-asc", label: "Name A-Z" },
  { value: "status", label: "Status" },
  { value: "next-run", label: "Next run" },
]

const statusOrder = { active: 0, paused: 1, expired: 2 } satisfies Record<LoopInfo["status"], number>

export function sortAutomations(items: readonly LoopInfo[], sort: AutomationSort) {
  return [...items].toSorted((a, b) => {
    const byCreated = Number(b.time.created) - Number(a.time.created) || b.id.localeCompare(a.id)

    if (sort === "created-asc") return -byCreated
    if (sort === "name-asc") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || byCreated
    if (sort === "status") return statusOrder[a.status] - statusOrder[b.status] || byCreated
    if (sort === "next-run") {
      const aNext = a.nextRunAt === undefined ? Number.POSITIVE_INFINITY : Number(a.nextRunAt)
      const bNext = b.nextRunAt === undefined ? Number.POSITIVE_INFINITY : Number(b.nextRunAt)
      return aNext - bNext || byCreated
    }
    return byCreated
  })
}
