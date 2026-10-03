import { checkDirectory, invalid, isRecord, parseResponse } from "./response-validation"

export type AuthPrompt = {
  key: string
  message: string
  when?: { key: string; op: "eq" | "neq"; value: string }
} & (
  | { type: "text"; placeholder?: string }
  | { type: "select"; options: { label: string; value: string; hint?: string }[] }
)

export type AuthMethod = { type: "oauth" | "api"; label: string; prompts?: AuthPrompt[] }

export function createProviders(options: { url: URL; headers: Headers; signal: AbortSignal }) {
  const url = new URL(options.url)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error("Use an HTTP(S) server origin without a path, credentials, query, or fragment.")
  const headers = new Headers(options.headers)
  headers.set("Accept", "application/json")
  const connectionSignal = options.signal
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  const secure = url.protocol === "https:" || loopback
  if (loopback) {
    // Bun consults NO_PROXY at request time; proxy: "" does not bypass shell proxies.
    const bypass = [process.env.NO_PROXY ?? "", process.env.no_proxy ?? "", "127.0.0.1,::1"]
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
    process.env.NO_PROXY = [...new Set(bypass)].join(",")
    process.env.no_proxy = process.env.NO_PROXY
  }
  async function request(
    path: string,
    input: {
      method?: "PUT" | "PATCH" | "POST"
      body?: object
      directory?: string
      secret?: boolean
      discard?: boolean
      signal?: AbortSignal
    } = {},
  ): Promise<unknown> {
    if (!secure && (input.secret || headers.has("authorization") || headers.has("cookie")))
      throw new Error("Provider credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
    const address = new URL(path, url)
    if (input.directory !== undefined) {
      checkDirectory(input.directory)
      address.searchParams.set("directory", input.directory)
    }
    const signal = AbortSignal.any([
      connectionSignal,
      AbortSignal.timeout(path.endsWith("/oauth/callback") ? 300000 : 10000),
      ...(input.signal ? [input.signal] : []),
    ])
    const requestHeaders = new Headers(headers)
    if (input.body) requestHeaders.set("Content-Type", "application/json")
    const failed = () =>
      new Error(
        signal.aborted
          ? "Provider request cancelled or timed out."
          : "Provider request failed. Check the server connection; redirects are not permitted.",
      )
    let response: Response
    try {
      signal.throwIfAborted()
      response = await fetch(address, {
        method: input.method ?? "GET",
        headers: requestHeaders,
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal,
        redirect: "error",
      })
    } catch {
      throw failed()
    }
    if (!response.ok || input.discard) {
      // Config PATCH returns the full config. Never read, parse, or retain it (or error bodies).
      await response.body?.cancel().catch(() => {})
      if (!response.ok) throw new Error(`Provider request failed (HTTP ${response.status}).`)
      return
    }
    if (!response.body) invalid("empty provider response")
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read().catch(() => {
          throw failed()
        })
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 8 * 1024 * 1024) throw new Error("Provider response exceeds the 8 MiB TUI limit.")
        if (chunks.length >= 8192) throw new Error("Provider response exceeds the 8,192 chunk TUI limit.")
        chunks.push(new Uint8Array(chunk.value))
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    return parseResponse(await new Blob(chunks).text())
  }

  async function catalog(selected: string, signal?: AbortSignal) {
    const result = record(await request("/provider", { directory: selected, signal }))
    const connected = new Set(array(result.connected, 1024).map((value) => id(value)))
    const seen = new Set<string>()
    const models: {
      providerID: string
      id: string
      name: string
      providerName: string
      variants?: string[]
      /** The published context window in tokens, when the provider states one. */
      context?: number
    }[] = []
    let count = 0
    const providers = array(result.all, 1024).map((value) => {
      const item = record(value)
      const provider = {
        id: id(item.id),
        name: text(item.name, "provider name"),
        connected: connected.has(id(item.id)),
      }
      if (seen.has(provider.id)) invalid("duplicate provider ID")
      seen.add(provider.id)
      for (const [key, value] of Object.entries(record(item.models))) {
        if (++count > 10000) invalid("more than 10,000 models")
        const model = record(value)
        const modelID = id(model.id, true)
        if (id(key, true) !== modelID || id(model.providerID) !== provider.id) invalid("model identity")
        const name = text(model.name, "model name")
        // The public provider catalog already removes disabled variants. Only names leave this adapter.
        const variants =
          model.variants === undefined
            ? undefined
            : array(Object.keys(record(model.variants)), 128).map((value) => id(value, true))
        const context = isRecord(model.limit) ? model.limit.context : undefined
        if (provider.connected)
          models.push({
            providerID: provider.id,
            id: modelID,
            name,
            providerName: provider.name,
            ...(variants && variants.length > 0 ? { variants } : {}),
            ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? { context } : {}),
          })
      }
      return provider
    })
    if ([...connected].some((value) => !seen.has(value))) invalid("unknown connected provider")
    return { providers, models }
  }

  async function globalProviderIDs(signal?: AbortSignal) {
    // Keep the full config inside this boundary; only validated IDs leave it.
    const config = record(await request("/global/config", { secret: true, signal }))
    const configured = ["provider", "providers"].flatMap((field) => {
      const keys = config[field] === undefined ? [] : Object.keys(record(config[field]))
      return array(keys, 1024).map((value) => id(value))
    })
    const disabled = config.disabled_providers === undefined ? [] : array(config.disabled_providers, 1024)
    return new Set([...configured, ...disabled.map((value) => id(value))])
  }

  async function connectKey(
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

  return {
    async list(selected: string) {
      checkDirectory(selected)
      return catalog(selected)
    },
    connectKey,
    async addCustom(
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
      if (!secure)
        throw new Error("Provider credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
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
        (await catalog(directory, signal)).providers.some((provider) => provider.id === providerID) ||
        (await globalProviderIDs(signal)).has(providerID)
      )
        throw new Error("Provider ID already exists. Connect it with a key, or choose a new custom provider ID.")
      try {
        await request("/global/config", { method: "PATCH", body: config, secret: true, discard: true, signal })
      } catch {
        throw new Error("Provider configuration could not be confirmed. Refresh providers before retrying.")
      }
      if (key === undefined) return
      try {
        await connectKey(providerID, key, undefined, signal)
      } catch {
        throw new Error(
          "Provider configuration was saved, but the API key could not be confirmed. Refresh providers and reconnect this provider before retrying.",
        )
      }
    },
    async auth(selected: string): Promise<Record<string, AuthMethod[]>> {
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
              ...(method.prompts === undefined
                ? {}
                : { prompts: array(method.prompts, 32).map((value) => prompt(value)) }),
            }
          }),
        ]),
      )
    },
    async authorize(
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
    },
    async complete(
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
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid("provider object")
  return value
}

function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid("provider collection")
  return value
}

function text(value: unknown, field: string, limit = 512, empty = false, multiline = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!empty && !value.trim()) ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
      multiline ? value.replaceAll("\n", "") : value,
    )
  )
    throw new Error(`Invalid ${field}: check length and control characters.`)
  return value
}

function id(value: unknown, model = false) {
  const result = text(value, model ? "model ID" : "provider or auth ID", model ? 512 : 256)
  if (
    ["__proto__", "prototype", "constructor"].includes(result) ||
    result !== result.trim() ||
    (!model && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result))
  )
    throw new Error("Invalid provider, model, or auth ID.")
  return result
}

function credential(value: unknown) {
  const result = text(value, "credential", 8192)
  if (result !== result.trim()) throw new Error("Remove surrounding whitespace from the credential.")
  return result
}

function methodIndex(value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 32) throw new Error("Choose a valid auth method index.")
}

function endpoint(value: string) {
  const url = URL.parse(text(value, "provider URL", 4096))
  if (!url || url.username || url.password || value.includes("?") || value.includes("#"))
    throw new Error("Use a provider URL without credentials, a query, or a fragment.")
  // Match SessionRunnerModel's runtime policy without importing Core into the TUI.
  const octets = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ? url.hostname.split(".").map(Number) : []
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Use HTTPS, or HTTP on a runtime-supported private or loopback provider address.")
  return url.href
}

function prompt(value: unknown): AuthPrompt {
  const item = record(value)
  const base: Pick<AuthPrompt, "key" | "message" | "when"> = {
    key: id(item.key),
    message: text(item.message, "auth prompt"),
  }
  if (item.when !== undefined) {
    const when = record(item.when)
    if (when.op !== "eq" && when.op !== "neq") invalid("auth prompt condition")
    base.when = { key: id(when.key), op: when.op, value: text(when.value, "auth condition", 4096, true) }
  }
  if (item.type === "text")
    return {
      ...base,
      type: "text",
      ...(item.placeholder === undefined ? {} : { placeholder: text(item.placeholder, "auth placeholder", 512, true) }),
    }
  if (item.type !== "select") invalid("auth prompt type")
  return {
    ...base,
    type: "select",
    options: array(item.options, 128).map((value) => {
      const option = record(value)
      return {
        label: text(option.label, "auth option label"),
        value: text(option.value, "auth option value", 4096, true),
        ...(option.hint === undefined ? {} : { hint: text(option.hint, "auth option hint", 512, true) }),
      }
    }),
  }
}
