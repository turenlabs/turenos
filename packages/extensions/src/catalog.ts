import { Extension } from "@turenlabs/schema"
import { manifests } from "./generated"

export { manifests }

const byID = new Map(manifests.map((manifest) => [manifest.id, manifest]))
const byAdapter = new Map(
  manifests.flatMap((manifest) => manifest.contributions.map((item) => [item.adapter, manifest])),
)

export function get(id: string) {
  return byID.get(id as (typeof manifests)[number]["id"])
}

export function forAdapter(adapter: string) {
  return byAdapter.get(adapter)
}

export function contribution(adapter: string) {
  return forAdapter(adapter)?.contributions.find((item) => item.adapter === adapter)
}

export function dataEndpoints(adapter: string) {
  const item = contribution(adapter)
  if (item?.type !== "data") throw new Error(`Missing data contribution for adapter: ${adapter}`)
  return item.endpoints
}

export function dataEndpoint(adapter: string, name?: string) {
  const endpoints = dataEndpoints(adapter)
  if (name !== undefined) {
    const url = endpoints[name]
    if (!url) throw new Error(`Data endpoint "${name}" is not declared for adapter: ${adapter}`)
    return url
  }
  const urls = Object.values(endpoints)
  const url = urls[0]
  if (urls.length !== 1 || !url) {
    throw new Error(`Adapter ${adapter} declares ${urls.length} endpoints; address one by name`)
  }
  return url
}

export const writeToolActions = manifests.flatMap((manifest) =>
  manifest.contributions.flatMap((item) => {
    if (!("tools" in item)) return []
    const tools = manifest.trust === "official" ? item.tools.write : item.tools.allow
    if (item.adapter.startsWith("mcp:")) return tools.map((tool) => `${item.id}_${tool}`)
    if (item.adapter.startsWith("security:")) return tools.map((tool) => `forge-security_${tool}`)
    return tools
  }),
)

export function instanceID(namespace: "configured-mcp" | "discovered-skill", identity: string) {
  const slug =
    identity
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36) || "item"
  const hash = [...identity].reduce((value, character) => {
    return Math.imul(value ^ character.charCodeAt(0), 16_777_619)
  }, 2_166_136_261)
  return Extension.ID.make(namespace, `${slug}-${(hash >>> 0).toString(36)}`)
}
