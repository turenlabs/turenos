import { Schema } from "effect"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"

export type ProxyRequest = { type: "security-proxy"; id: string; command: SecurityProxy.StoreCommand }
export type ProxyCommand = { type: "security-proxy-command"; id: string; command: SecurityProxy.Command }
export type ProxyReply = { type: "security-proxy-result"; id: string; result?: SecurityProxy.Result; error?: string }

const request = Schema.Struct({
  type: Schema.Literal("security-proxy"),
  id: Schema.String,
  command: SecurityProxy.StoreCommand,
})
const command = Schema.Struct({
  type: Schema.Literal("security-proxy-command"),
  id: Schema.String,
  command: SecurityProxy.Command,
})

export function parseProxyRequest(value: unknown): ProxyRequest | undefined {
  if (!Schema.is(request)(value)) return
  if (value.id.length > 128 || JSON.stringify(value).length > 8 * 1024 * 1024) return
  return value
}

export function parseProxyCommand(value: unknown): ProxyCommand | undefined {
  if (!Schema.is(command)(value)) return
  if (value.id.length > 128 || JSON.stringify(value).length > 8 * 1024 * 1024) return
  return value
}

export function parseProxyReply(value: unknown): ProxyReply | undefined {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "security-proxy-result") return
  if (!("id" in value) || typeof value.id !== "string" || value.id.length > 128) return
  if ("error" in value && typeof value.error === "string")
    return { type: value.type, id: value.id, error: value.error.slice(0, 1024) }
  if (!("result" in value) || !Schema.is(SecurityProxy.Result)(value.result)) return
  return { type: value.type, id: value.id, result: value.result }
}
