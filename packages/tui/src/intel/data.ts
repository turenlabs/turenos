import { display } from "../messages"
import { array, numeric, object, optional, string } from "../response-validation"
import type { Connection } from "../server"
import { label } from "../state"
import { color } from "../theme"

export type Mode = "advisories" | "kev" | "news"
export type Item = { title: string; meta: string; body: string; tone: string }
type Intel = Connection["client"]["server.intel"]

export const TITLES: Record<Mode, string> = { advisories: "Advisories", kev: "Known exploited (KEV)", news: "News" }
export const PAGE = 50
const TAG: Record<string, string> = { critical: "CRIT", high: "HIGH", medium: "MED", low: "LOW", info: "INFO" }
const SEVERITY: Record<string, string> = {
  critical: color.error,
  high: color.error,
  medium: color.warning,
  low: color.muted,
  info: color.muted,
}

export async function fetchPage(intel: Intel, mode: Mode, page: number): Promise<{ items: Item[]; total: number }> {
  if (mode === "advisories") return advisories(intel, page)
  if (mode === "kev") return kev(intel, page)
  return news(intel, page)
}

async function advisories(intel: Intel, page: number) {
  const result = await intel.advisories({ page, pageSize: PAGE, sort: "severity", order: "desc" })
  return {
    total: numeric(result.total),
    items: array(result.items, 1000).map((value) => {
      const item = object(value)
      optional(item.summary, string)
      optional(item.url, string)
      const severity = string(item.severity, 16)
      return {
        title: `${TAG[severity] ?? severity.toUpperCase()} ${string(item.title, 2000)}`,
        meta: `${string(item.id, 256)} · ${string(item.source, 256)} · ${date(item.publishedAt)}${typeof item.cvss === "number" ? ` · CVSS ${item.cvss}` : ""}`,
        body: `${display((item.summary as string | undefined) ?? "", 8000)}${item.url ? `\n\n${label(item.url as string, 500)}` : ""}`,
        tone: SEVERITY[severity] ?? color.muted,
      }
    }),
  }
}

async function kev(intel: Intel, page: number) {
  const result = await intel.kev({ page, pageSize: PAGE, sort: "dateAdded", order: "desc" })
  return {
    total: numeric(result.total),
    items: array(result.items, 1000).map((value) => {
      const item = object(value)
      optional(item.url, string)
      return {
        title: `${string(item.cveID, 64)} ${string(item.name, 2000)}`,
        meta: `${string(item.vendor, 256)} ${string(item.product, 256)} · added ${date(item.dateAdded)}${typeof item.dueDate === "number" ? ` · remediate by ${date(item.dueDate)}` : ""}`,
        body: item.url ? label(item.url as string, 500) : "",
        tone: color.error,
      }
    }),
  }
}

async function news(intel: Intel, page: number) {
  const result = await intel.news({ page, pageSize: PAGE, sort: "publishedAt", order: "desc" })
  return {
    total: numeric(result.total),
    items: array(result.items, 1000).map((value) => {
      const item = object(value)
      optional(item.summary, string)
      return {
        title: string(item.title, 2000),
        meta: `${string(item.source, 256)} · ${date(item.publishedAt)}`,
        body: `${display((item.summary as string | undefined) ?? "", 8000)}\n\n${label(string(item.url, 2000), 500)}`,
        tone: color.muted,
      }
    }),
  }
}

function date(value: unknown) {
  return new Date(numeric(value)).toLocaleDateString()
}
