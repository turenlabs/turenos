import { display } from "../messages"

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
  const merged = new Map(items.map((item) => [item.name, item]))
  for (const item of local.filter(validName)) {
    if (!merged.has(item.name)) merged.set(item.name, { name: item.name, description: item.description, local: true })
  }
  return [...merged.values()].filter((item) => item.name.startsWith(query))
}

export function describe(item: Choice) {
  return `/${item.name} - ${display(item.description ?? "", 120).replace(/\s/g, " ")}`
}
