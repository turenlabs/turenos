export * as OpenAICodex from "./openai-codex"

import { Option, Schema } from "effect"

export const API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const ACCOUNT_HEADER = "ChatGPT-Account-Id"

const allowedModels = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.6-cyber",
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
])

const codexModelAliases = new Map([
  ["daybreak-blue-latest", "gpt-daybreak-blue-latest"],
  ["daybreak-red-latest", "gpt-daybreak-red-latest"],
])

const TokenClaims = Schema.Struct({
  chatgpt_account_id: Schema.optional(Schema.String),
  organizations: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  email: Schema.optional(Schema.String),
  "https://api.openai.com/auth": Schema.optional(Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) })),
})
export type TokenClaims = typeof TokenClaims.Type

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(TokenClaims))

export type TokenResponse = {
  readonly id_token?: string
  readonly access_token?: string
  readonly refresh_token?: string
}

export const codexModelID = (apiID: string) => codexModelAliases.get(apiID) ?? apiID

export const eligible = (apiID: string, reasoningMode?: unknown) => {
  if (reasoningMode === "pro") return false
  return allowedModels.has(codexModelID(apiID))
}

export const parseClaims = (token: string): TokenClaims | undefined => {
  const part = token.split(".")
  if (part.length !== 3) return
  return Option.getOrUndefined(decodeClaims(Buffer.from(part[1]!, "base64url").toString()))
}

export const accountIDFromClaims = (claims: TokenClaims) =>
  claims.chatgpt_account_id ??
  claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
  claims.organizations?.[0]?.id

export const accountID = (tokens: TokenResponse) => {
  const id = tokens.id_token ? parseClaims(tokens.id_token) : undefined
  const fromID = id ? accountIDFromClaims(id) : undefined
  if (fromID) return fromID
  const access = tokens.access_token ? parseClaims(tokens.access_token) : undefined
  return access ? accountIDFromClaims(access) : undefined
}

export const authorizationHeaders = (access: string, accountID?: string) => ({
  authorization: `Bearer ${access}`,
  ...(accountID ? { [ACCOUNT_HEADER]: accountID } : {}),
})

export const projectRequest = (input: {
  readonly request: Parameters<typeof fetch>[0]
  readonly init?: RequestInit
  readonly access: string
  readonly accountID?: string
  readonly endpoint?: string
}) => {
  const headers = new Headers(input.init?.headers)
  Object.entries(authorizationHeaders(input.access, input.accountID)).forEach(([name, value]) =>
    headers.set(name, value),
  )
  const source =
    input.request instanceof URL
      ? input.request
      : new URL(typeof input.request === "string" ? input.request : input.request.url)
  const body = projectBody(input.init?.body)
  return {
    url:
      source.pathname.includes("/v1/responses") || source.pathname.includes("/chat/completions")
        ? new URL(input.endpoint ?? API_ENDPOINT)
        : source,
    init: {
      ...input.init,
      body,
      headers,
    } satisfies RequestInit,
  }
}

function projectBody(body: RequestInit["body"]) {
  if (typeof body !== "string") return body
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body))
  if (!isRecord(decoded) || typeof decoded.model !== "string") return body
  const model = codexModelID(decoded.model)
  if (model === decoded.model) return body
  return JSON.stringify({ ...decoded, model })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
