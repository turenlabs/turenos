import { array, choice, identifier, numeric, object, optional, string, unique } from "./primitives"

export function memories(route: string[], init: RequestInit | undefined, value: unknown) {
  const method = init?.method ?? "GET"
  if (method === "GET") return unique(array(value, 5000), (entry) => memoryItem(route, entry))
  if (method === "POST") memoryItem(route, value)
}

function memoryItem(route: string[], entry: unknown) {
  const item = object(entry)
  identifier(item.id)
  string(route.length > 1 ? item.name : item.title, 4096)
  if (route[1] === "wing") {
    string(item.kind, 64)
    string(item.key, 4096)
    return
  }
  if (route[1] === "room") {
    optional(item.wingID, identifier)
    string(item.slug, 512)
    return
  }
  if (route.length > 1) return
  optional(item.wingID, identifier)
  optional(item.roomID, identifier)
  optional(item.timeUpdated, numeric)
  choice(item.kind, ["note", "fact", "decision", "observation"])
  string(item.body)
  optional(item.supersededBy, identifier)
  const provenance = object(item.provenance)
  string(provenance.assertedBy, 512)
  string(provenance.source, 32)
  const anchor = object(item.anchor)
  optional(anchor.path, string)
  optional(anchor.symbol, string)
}

export function savedPermissions(value: unknown) {
  unique(array(object(value).data, 5000), (entry) => {
    const item = object(entry)
    identifier(item.id)
    string(item.action, 512)
    string(item.resource, 64000)
  })
}
