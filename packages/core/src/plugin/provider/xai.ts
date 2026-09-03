import type { IntegrationOAuthMethodRegistration } from "@turenlabs/plugin/v2/effect/integration"
import { define } from "@turenlabs/plugin/v2/effect/plugin"
import { Effect } from "effect"
import { isXaiOAuthModel } from "../../aisdk"
import { Credential } from "../../credential"
import { InstallationVersion } from "../../installation/version"
import { Integration } from "../../integration"
import { ProviderV2 } from "../../provider"

const XAI_API_ORIGIN = "https://api.x.ai"
const XAI_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1"
const XAI_CLI_TOKEN_AUTH = "xai-grok-cli"
const XAI_CLI_CLIENT_IDENTIFIER = "grok-shell"
const XAI_CLI_USER_AGENT = "xai-grok-cli"
// Keep this fallback aligned with the Grok CLI version accepted by xAI. A
// locally installed CLI can override it for operators that need a newer value.
const XAI_CLI_CLIENT_VERSION = "0.2.103"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const browserMethodID = Integration.MethodID.make("grok-browser")

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

const oauth = {
  integrationID: Integration.ID.make("xai"),
  method: {
    id: browserMethodID,
    type: "oauth",
    label: "xAI Grok OAuth (SuperGrok Subscription)",
  },
  authorize: () => Effect.fail(new Error("xAI Grok OAuth login is handled by the v1 SuperGrok flow")),
  refresh: (value) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": `forge/${InstallationVersion}`,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: value.refresh,
            client_id: CLIENT_ID,
          }).toString(),
          signal,
        })
        if (!response.ok) throw new Error(`xAI token refresh failed (${response.status})`)
        const tokens = (await response.json()) as Partial<TokenResponse>
        if (typeof tokens.access_token !== "string" || !tokens.access_token) {
          throw new Error("xAI token refresh response is invalid")
        }
        return Credential.OAuth.make({
          type: "oauth",
          methodID: browserMethodID,
          access: tokens.access_token,
          refresh: tokens.refresh_token || value.refresh,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          metadata: value.metadata,
        })
      },
      catch: (cause) => cause,
    }),
} satisfies IntegrationOAuthMethodRegistration

export const XAIPlugin = define({
  id: "xai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      draft.method.update(oauth)
    })
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/xai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/xai"))
        if (
          evt.model.providerID !== ProviderV2.ID.make("xai") ||
          !isXaiOAuthModel(evt.model) ||
          !xaiUsesDefaultEndpoint(evt.model.api.type === "aisdk" ? evt.model.api.url : undefined, evt.options)
        ) {
          evt.sdk = mod.createXai(evt.options)
          return
        }
        evt.sdk = mod.createXai({
          ...evt.options,
          baseURL: XAI_CLI_PROXY_BASE_URL,
          headers: {
            ...Object.fromEntries(new Headers(evt.options.headers).entries()),
            "X-XAI-Token-Auth": XAI_CLI_TOKEN_AUTH,
            "x-grok-client-identifier": XAI_CLI_CLIENT_IDENTIFIER,
            "x-grok-client-version": process.env.GROK_CLI_VERSION?.trim() || XAI_CLI_CLIENT_VERSION,
            "x-grok-model-override": String(evt.model.api.id),
            "User-Agent": XAI_CLI_USER_AGENT,
          },
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("xai")) return
        evt.language = evt.sdk.responses(evt.model.api.id)
      }),
    )
  }),
})

const xaiUsesDefaultEndpoint = (modelURL: string | undefined, options: Record<string, unknown>) => {
  const configured = typeof options.baseURL === "string" ? options.baseURL : modelURL
  if (configured === undefined) return true
  try {
    return new URL(configured).origin === XAI_API_ORIGIN
  } catch {
    return false
  }
}
