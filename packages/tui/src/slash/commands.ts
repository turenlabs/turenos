import { display } from "../messages"
import { fuzzyFilter } from "../suggest/fuzzy"

export type Command = { name: string; description?: string }
export type Choice = Command & { local: boolean }
export type LocalCommand = { name: string; description: string; run: () => void }

export function matchSlash(text: string) {
  const prefix = /^\/([^\s/]*)[ \t]*$/.exec(text)
  if (!prefix || prefix[0] !== text) return undefined
  return { query: prefix[1]!, start: 0, end: text.length }
}

export function validName(item: Command) {
  // Reject unsafe names rather than rewriting the command that would be submitted.
  return (
    typeof item?.name === "string" &&
    item.name.length <= 120 &&
    /^[^\s/]+$/.test(item.name) &&
    display(item.name, 120) === item.name &&
    (item.description === undefined || typeof item.description === "string")
  )
}

export function validInventory(items: readonly Command[]) {
  if (!Array.isArray(items) || items.length > 2048) throw new Error("Invalid command inventory")
  return items.filter(validName).map((item): Choice => ({ ...item, local: false }))
}

export function mergeLocal(items: readonly Choice[], local: readonly LocalCommand[], query: string) {
  const names = new Set(items.map((item) => item.name))
  // The client's own commands lead, so /help and /new are not buried under the server's; a server name wins a clash.
  const own = local
    .filter((item) => validName(item) && !names.has(item.name))
    .map((item): Choice => ({ name: item.name, description: item.description, local: true }))
  return fuzzyFilter([...own, ...items], query, (item) => item.name)
}

/** `/name - description`, with the description cut at a word and an ellipsis, or dropped when little of it fits. */
export function describe(item: Choice, width = Infinity) {
  const name = `/${item.name}`
  const description = display(item.description ?? "", 120)
    .replace(/\s+/g, " ")
    .trim()
  if (!description) return name
  const full = `${name} - ${description}`
  if (full.length <= width) return full
  const room = width - name.length - 3 - 1
  const head = description.slice(0, Math.max(0, room + 1))
  const cut = /\s$/.test(head) ? head.trimEnd() : head.replace(/\s+\S*$/, "")
  // A stub such as "Sk…" says nothing, so the name stands alone.
  return cut.length < 8 || room < 8 ? name : `${name} - ${cut}…`
}
