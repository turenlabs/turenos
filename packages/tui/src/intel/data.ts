import { display } from "../messages"
import { array, numeric, object, optional, string } from "../response-validation"
import type { Connection } from "../server"
import { stamp } from "../menus/stamp"
import { label } from "../state"
import { color } from "../theme"

export type Mode = "advisories" | "kev" | "news"
/** `row` is the one-line list entry: the title, with the summary's first line after a bare id. */
export type Item = { title: string; row: string; meta: string; body: string; tone: string }
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
      const tag = Object.hasOwn(TAG, severity) ? TAG[severity]! : severity.toUpperCase()
      const name = string(item.title, 2000)
      const summary = plain((item.summary as string | undefined) ?? "")
      return {
        title: label(`${tag} ${name}`, 2000),
        // A title that is only an id says nothing, so the summary's first line follows it.
        row: label(`${tag} ${name}${/^(CVE|GHSA)-[\w-]+$/i.test(name.trim()) ? ` ${summary}` : ""}`, 2000),
        meta: label(
          `${string(item.id, 256)} · ${string(item.source, 256)} · ${date(item.publishedAt)}${typeof item.cvss === "number" ? ` · CVSS ${item.cvss}` : ""}`,
          600,
        ),
        body: `${display(summary, 8000)}${item.url ? `\n\n${link(item.url as string)}` : ""}`,
        tone: Object.hasOwn(SEVERITY, severity) ? SEVERITY[severity]! : color.muted,
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
      const title = label(`${string(item.cveID, 64)} ${string(item.name, 2000)}`, 2000)
      return {
        title,
        row: title,
        meta: label(
          `${string(item.vendor, 256)} ${string(item.product, 256)} · added ${date(item.dateAdded)}${typeof item.dueDate === "number" ? ` · remediate by ${date(item.dueDate)}` : ""}`,
          600,
        ),
        body: item.url ? link(item.url as string) : "",
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
      const title = label(string(item.title, 2000), 2000)
      return {
        title,
        row: title,
        meta: label(`${string(item.source, 256)} · ${date(item.publishedAt)}`, 300),
        body: `${display(plain((item.summary as string | undefined) ?? ""), 8000)}\n\n${link(string(item.url, 2000))}`,
        tone: color.muted,
      }
    }),
  }
}

/** `YYYY-MM-DD`, like every other date in the client. */
function date(value: unknown) {
  return stamp(numeric(value)).slice(0, 10)
}

/** Advisory text arrives as Markdown, which this pane does not render: the markup characters are dropped. */
function plain(text: string) {
  return text
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.+?)\1/gs, "$2")
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s+/gm, "")
}

/** A web link shown as the URL parser reads it (punycode host), or withheld when it could read as something else. */
function link(value: string) {
  // oxlint-disable-next-line no-control-regex -- control and invisible characters are the point of this check
  const hidden = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/
  const url = hidden.test(value) ? null : URL.parse(value)
  if (!url || !["http:", "https:"].includes(url.protocol) || /[^\x21-\x7e]/.test(url.hostname)) return "(link withheld)"
  return label(url.href, 500)
}
