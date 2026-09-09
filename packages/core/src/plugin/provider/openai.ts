import { createServer } from "node:http"
import type { IntegrationOAuthMethodRegistration } from "@turenlabs/plugin/v2/effect/integration"
import { define } from "@turenlabs/plugin/v2/effect/plugin"
import { Deferred, Effect } from "effect"
import type { Scope } from "effect"
import { Credential } from "../../credential"
import { InstallationVersion } from "../../installation/version"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { OauthCallbackPage } from "../../oauth/page"
import { ProviderV2 } from "../../provider"
import type { PluginInternal } from "../internal"
import { OpenAICodex } from "./openai-codex"

const clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
const issuer = "https://auth.openai.com"
const callbackPort = 1455
const pollingSafetyMargin = 3000
const browserMethodID = Integration.MethodID.make("chatgpt-browser")
const headlessMethodID = Integration.MethodID.make("chatgpt-headless")
const OPENAI_PROVIDER_ID = ProviderV2.ID.openai
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]
const OPENAI_MODELS = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    fallback: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    cost: [
      { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
      {
        tier: { type: "context" as const, size: 272_000 },
        input: 20,
        output: 75,
        cache: { read: 2, write: 25 },
      },
    ],
  },
  {
    id: "daybreak-blue-latest",
    name: "Daybreak Blue",
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    cost: [
      { input: 5, output: 30, cache: { read: 0.5, write: 6.25 } },
      {
        tier: { type: "context" as const, size: 272_000 },
        input: 10,
        output: 45,
        cache: { read: 1, write: 12.5 },
      },
    ],
  },
  {
    id: "daybreak-red-latest",
    name: "Daybreak Red",
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    cost: [{ input: 12.5, output: 75, cache: { read: 1.25, write: 15.625 } }],
  },
  {
    id: "gpt-5.6-cyber",
    name: "GPT-5.6 Cyber",
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    cost: [{ input: 12.5, output: 75, cache: { read: 1.25, write: 15.625 } }],
  },
]

type Pkce = {
  verifier: string
  challenge: string
}

type TokenResponse = {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

const browser = {
  integrationID: Integration.ID.make("openai"),
  method: {
    id: browserMethodID,
    type: "oauth",
    label: "ChatGPT Pro/Plus (browser)",
  },
  authorize: () =>
    Effect.gen(function* () {
      const pkce = yield* Effect.promise(generatePKCE)
      const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
      const code = yield* Deferred.make<string, Error>()
      const redirect = `http://localhost:${callbackPort}/auth/callback`
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", `http://localhost:${callbackPort}`)
        if (url.pathname !== "/auth/callback") {
          response.writeHead(404).end("Not found")
          return
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        const value = url.searchParams.get("code")
        if (error) {
          Effect.runFork(Deferred.fail(code, new Error(error)))
          response
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error(error, { provider: "ChatGPT" }))
          return
        }
        if (!value || url.searchParams.get("state") !== state) {
          const message = value ? "Invalid OAuth state" : "Missing authorization code"
          Effect.runFork(Deferred.fail(code, new Error(message)))
          response
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error(message, { provider: "ChatGPT" }))
          return
        }
        Effect.runFork(Deferred.succeed(code, value))
        response.writeHead(200, { "Content-Type": "text/html" }).end(OauthCallbackPage.success({ provider: "ChatGPT" }))
      })
      yield* Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)))
        server.listen(callbackPort, "localhost", () => resume(Effect.void))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      return {
        mode: "auto" as const,
        url: authorizeURL(redirect, pkce, state),
        instructions: "Complete authorization in your browser. This window will close automatically.",
        callback: Deferred.await(code).pipe(
          Effect.flatMap((value) => exchange(value, redirect, pkce)),
          Effect.map((tokens) => credential(browserMethodID, tokens)),
        ),
      }
    }),
  refresh: (value) => refresh(browserMethodID, value),
} satisfies IntegrationOAuthMethodRegistration

const headless = {
  integrationID: Integration.ID.make("openai"),
  method: {
    id: headlessMethodID,
    type: "oauth",
    label: "ChatGPT Pro/Plus (headless)",
  },
  authorize: () =>
    Effect.gen(function* () {
      const device = yield* request<{ device_auth_id: string; user_code: string; interval: string }>(
        `${issuer}/api/accounts/deviceauth/usercode`,
        {
          method: "POST",
          headers: headers("application/json"),
          body: JSON.stringify({ client_id: clientID }),
        },
      )
      const interval = Math.max(Number.parseInt(device.interval) || 5, 1) * 1000
      return {
        mode: "auto" as const,
        url: `${issuer}/codex/device`,
        instructions: `Enter code: ${device.user_code}`,
        callback: Effect.gen(function* () {
          while (true) {
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(`${issuer}/api/accounts/deviceauth/token`, {
                  method: "POST",
                  headers: headers("application/json"),
                  body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
                  signal,
                }),
              catch: (cause) => cause,
            })
            if (response.ok) {
              const data = (yield* Effect.promise(() => response.json())) as {
                authorization_code: string
                code_verifier: string
              }
              return credential(
                headlessMethodID,
                yield* exchange(data.authorization_code, `${issuer}/deviceauth/callback`, {
                  verifier: data.code_verifier,
                  challenge: "",
                }),
              )
            }
            if (response.status !== 403 && response.status !== 404) {
              return yield* Effect.fail(new Error(`Device authorization failed: ${response.status}`))
            }
            yield* Effect.sleep(interval + pollingSafetyMargin)
          }
        }),
      }
    }),
  refresh: (value) => refresh(headlessMethodID, value),
} satisfies IntegrationOAuthMethodRegistration

export const OpenAIPlugin = define({
  id: "openai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      draft.method.update(browser)
      draft.method.update(headless)
    })
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        evt.provider.update(OPENAI_PROVIDER_ID, (provider) => {
          if (provider.name === String(OPENAI_PROVIDER_ID)) provider.name = "OpenAI"
          if (provider.api.type === "native" && !provider.api.url && Object.keys(provider.api.settings).length === 0) {
            provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
          }
        })
        for (const definition of OPENAI_MODELS) {
          // Let models.dev supply Astra's metadata as soon as its direct OpenAI entry lands.
          if (definition.fallback && evt.model.get(OPENAI_PROVIDER_ID, ModelV2.ID.make(definition.id))) continue
          evt.model.update(OPENAI_PROVIDER_ID, ModelV2.ID.make(definition.id), (model) => {
            model.name = definition.name
            model.api = {
              id: ModelV2.ID.make(definition.id),
              type: "aisdk",
              package: "@ai-sdk/openai",
            }
            model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
            model.variants = (definition.reasoningEfforts ?? REASONING_EFFORTS).map((id) => ({
              id,
              headers: {},
              body: { reasoningEffort: id },
            }))
            model.time.released = 0
            model.cost = definition.cost
            model.status = "active"
            model.enabled = true
            model.limit = definition.limit
          })
        }
        evt.model.update(OPENAI_PROVIDER_ID, ModelV2.ID.make("gpt-6-astra"), (model) => {
          // Stateless turns need the encrypted reasoning to continue without discarding it.
          model.request.body.include ??= ["reasoning.encrypted_content"]
        })
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai") continue
          for (const model of item.models.values()) {
            if (model.api.id !== "gpt-5-chat-latest" && !model.api.id.includes("realtime")) continue
            evt.model.update(item.provider.id, model.id, (draft) => {
              // The retired chat alias and Realtime-only models cannot use the
              // Responses coding-session route this provider owns.
              draft.enabled = false
            })
          }
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/openai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai"))
        evt.sdk = mod.createOpenAI(evt.options)
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.openai) return
        evt.language = evt.sdk.responses(evt.model.api.id)
      }),
    )
  }),
} satisfies PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>)

function headers(contentType: string) {
  return { "Content-Type": contentType, "User-Agent": `TurenOS/${InstallationVersion}` }
}

function exchange(code: string, redirect: string, pkce: Pkce) {
  return request<TokenResponse>(`${issuer}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
}

function refresh(methodID: Integration.MethodID, value: Pick<Credential.OAuth, "refresh" | "metadata">) {
  return request<TokenResponse>(`${issuer}/oauth/token`, {
    method: "POST",
    headers: headers("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: value.refresh,
      client_id: clientID,
    }).toString(),
  }).pipe(
    Effect.map((tokens) => {
      const next = credential(methodID, tokens)
      return Credential.OAuth.make({ ...next, metadata: next.metadata ?? value.metadata })
    }),
  )
}

function request<A>(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return response.json() as Promise<A>
    },
    catch: (cause) => cause,
  })
}

function credential(methodID: Integration.MethodID, tokens: TokenResponse) {
  const accountID = OpenAICodex.accountID(tokens)
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    metadata: accountID ? { accountID } : undefined,
  })
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

function authorizeURL(redirect: string, pkce: Pkce, state: string) {
  return `${issuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientID,
    redirect_uri: redirect,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    prompt: "login",
    state,
    originator: "opencode",
  })}`
}
