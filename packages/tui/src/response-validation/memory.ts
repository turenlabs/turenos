import { array, choice, identifier, object, optional, string } from "./primitives"

export function memories(route: string[], value: unknown) {
  for (const entry of array(value, 5000)) {
    const item = object(entry)
    identifier(item.id)
    string(item.name ?? item.title, 4096)
    if (route[1] === "wing") string(item.key, 4096)
    if (route[1] === "room") string(item.slug, 512)
    if (route.length > 1) continue
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
}

export function savedPermissions(value: unknown) {
  for (const entry of array(object(value).data, 5000)) {
    const item = object(entry)
    identifier(item.id)
    string(item.action, 512)
    string(item.resource, 64000)
  }
}
