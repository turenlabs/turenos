import { checkDirectory, invalid } from "../response-validation"
import { catalog, globalProviderIDs } from "./catalog"
import type { ProviderRequest } from "./request"
import { array, credential, endpoint, id, methodIndex, prompt, record, text, type AuthMethod } from "./validation"

export async function connectKey(
  request: ProviderRequest,
  providerID: string,
  key: string,
  metadata?: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const entries = metadata === undefined ? undefined : Object.entries(record(metadata))
  if (entries && entries.length > 32) throw new Error("Use at most 32 auth inputs.")
  const result = await request(`/auth/${encodeURIComponent(id(providerID))}`, {
    method: "PUT",
    body: {
      type: "api",
      key: credential(key),
      ...(entries === undefined
        ? {}
        : {
            metadata: Object.fromEntries(
              entries.map(([key, value]) => [id(key), text(value, "auth input", 4096, true)]),
            ),
          }),
    },
    secret: true,
    signal,
  })
  if (result !== true) invalid("API key acknowledgement")
}

export async function addCustom(
  request: ProviderRequest,
  secure: boolean,
  input: {
    providerID: string
    name: string
    baseURL: string
    modelID: string
    modelName: string
    key?: string
  },
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!secure) throw new Error("Provider credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
  checkDirectory(directory)
  const providerID = id(input.providerID)
  const config = {
    provider: {
      [providerID]: {
        npm: "@ai-sdk/openai-compatible",
        name: text(input.name, "provider name"),
        options: { baseURL: endpoint(input.baseURL) },
        models: { [id(input.modelID, true)]: { name: text(input.modelName, "model name") } },
      },
    },
  }
  const key = input.key === undefined ? undefined : credential(input.key)
  // Preflight is advisory: V1 config can omit native providers, and other clients can race it.
  if (
    (await catalog(request, directory, signal)).providers.some((provider) => provider.id === providerID) ||
    (await globalProviderIDs(request, signal)).has(providerID)
  )
    throw new Error("Provider ID already exists. Connect it with a key, or choose a new custom provider ID.")
  try {
    await request("/global/config", { method: "PATCH", body: config, secret: true, discard: true, signal })
  } catch {
    throw new Error("Provider configuration could not be confirmed. Refresh providers before retrying.")
  }
  if (key === undefined) return
  try {
    await connectKey(request, providerID, key, undefined, signal)
  } catch {
    throw new Error(
      "Provider configuration was saved, but the API key could not be confirmed. Refresh providers and reconnect this provider before retrying.",
    )
  }
}

export async function auth(request: ProviderRequest, selected: string): Promise<Record<string, AuthMethod[]>> {
  const result = Object.entries(record(await request("/provider/auth", { directory: selected })))
  if (result.length > 1024) invalid("more than 1,024 auth providers")
  return Object.fromEntries(
    result.map(([key, value]) => [
      id(key),
      array(value, 32).map((value): AuthMethod => {
        const method = record(value)
        if (method.type !== "oauth" && method.type !== "api") invalid("auth method type")
        return {
          type: method.type,
          label: text(method.label, "auth label"),
          ...(method.prompts === undefined ? {} : { prompts: array(method.prompts, 32).map((value) => prompt(value)) }),
        }
      }),
    ]),
  )
}

export async function authorize(
  request: ProviderRequest,
  selected: string,
  providerID: string,
  method: number,
  inputs?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ url: string; method: "auto" | "code"; instructions: string }> {
  methodIndex(method)
  const entries = inputs === undefined ? undefined : Object.entries(record(inputs))
  if (entries && entries.length > 32) throw new Error("Use at most 32 auth inputs.")
  const result = record(
    await request(`/provider/${encodeURIComponent(id(providerID))}/oauth/authorize`, {
      method: "POST",
      directory: selected,
      secret: true,
      signal,
      body: {
        method,
        ...(entries === undefined
          ? {}
          : {
              inputs: Object.fromEntries(
                entries.map(([key, value]) => [id(key), text(value, "auth input", 4096, true)]),
              ),
            }),
      },
    }),
  )
  if (result.method !== "auto" && result.method !== "code") invalid("OAuth completion method")
  const address = URL.parse(text(result.url, "OAuth URL", 8192))
  if (
    !address ||
    address.username ||
    address.password ||
    address.hash ||
    !(
      address.protocol === "https:" ||
      (address.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(address.hostname))
    )
  )
    invalid("OAuth URL")
  return {
    url: address.href,
    method: result.method,
    instructions: text(result.instructions, "OAuth instructions", 8192, true, true),
  }
}

export async function complete(
  request: ProviderRequest,
  selected: string,
  providerID: string,
  method: number,
  code?: string,
  signal?: AbortSignal,
): Promise<void> {
  methodIndex(method)
  const result = await request(`/provider/${encodeURIComponent(id(providerID))}/oauth/callback`, {
    method: "POST",
    directory: selected,
    secret: true,
    signal,
    body: { method, ...(code === undefined ? {} : { code: credential(code) }) },
  })
  if (result !== true) invalid("OAuth acknowledgement")
}
