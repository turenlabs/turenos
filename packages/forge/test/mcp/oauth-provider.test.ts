import { test, expect, describe } from "bun:test"
import { determineScope } from "@modelcontextprotocol/sdk/client/auth.js"
import { McpOAuthProvider, OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "../../src/mcp/oauth-provider"
import { McpAuth } from "../../src/mcp/auth"
import { Effect } from "effect"

// Stub auth — only synchronous getters are exercised in these tests
const stubAuth = {} as McpAuth.Interface

const makeProvider = (config: ConstructorParameters<typeof McpOAuthProvider>[2]) =>
  new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", config, { onRedirect: async () => {} }, stubAuth)

describe("McpOAuthProvider.redirectUrl", () => {
  test("defaults to 127.0.0.1:19876/mcp/oauth/callback", () => {
    const provider = makeProvider({})
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`)
  })

  test("uses callbackPort when set", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`)
  })

  test("redirectUri takes precedence over callbackPort", () => {
    const provider = makeProvider({
      callbackPort: 6620,
      redirectUri: "http://127.0.0.1:9999/custom/callback",
    })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:9999/custom/callback")
  })

  test("uses explicit redirectUri when set without callbackPort", () => {
    const provider = makeProvider({ redirectUri: "http://127.0.0.1:8080/oauth/callback" })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8080/oauth/callback")
  })
})

describe("McpOAuthProvider.clientMetadata", () => {
  test("includes redirect_uris from redirectUrl", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.clientMetadata.redirect_uris).toEqual([`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`])
  })

  test("includes scope when set in config", () => {
    const provider = makeProvider({ scope: "openid offline_access" })
    expect(provider.clientMetadata.scope).toBe("openid offline_access")
  })

  test("omits scope when not set in config", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.scope).toBeUndefined()
  })

  test("sets token_endpoint_auth_method to client_secret_post when clientSecret provided", () => {
    const provider = makeProvider({ clientSecret: "secret" })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  })

  test("sets token_endpoint_auth_method to none when no clientSecret", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none")
  })
})

describe("MCP OAuth scope selection", () => {
  test("adds offline_access when the authorization server and client support refresh tokens", () => {
    expect(
      determineScope({
        resourceMetadata: {
          resource: "https://mcp.example.com/mcp",
          scopes_supported: ["resource.read"],
        },
        authServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          scopes_supported: ["resource.read", "offline_access"],
        },
        clientMetadata: makeProvider({}).clientMetadata,
      }),
    ).toBe("resource.read offline_access")
  })

  test("does not add unsupported authorization server scopes", () => {
    expect(
      determineScope({
        resourceMetadata: {
          resource: "https://mcp.example.com/mcp",
          scopes_supported: ["resource.read"],
        },
        authServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          scopes_supported: ["resource.read"],
        },
        clientMetadata: makeProvider({}).clientMetadata,
      }),
    ).toBe("resource.read")
  })
})

describe("McpOAuthProvider token rotation", () => {
  test("preserves the current refresh token when a refresh response omits it", async () => {
    const updates: McpAuth.Tokens[] = []
    const unexpected = () => Effect.die("unexpected MCP auth operation")
    const auth = McpAuth.Service.of({
      all: unexpected,
      get: unexpected,
      getForUrl: () =>
        Effect.succeed({
          serverUrl: "https://mcp.example.com/mcp",
          tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
        }),
      prepareForUrl: unexpected,
      generationForUrl: unexpected,
      set: unexpected,
      remove: unexpected,
      updateTokens: (_name: string, tokens: McpAuth.Tokens) => Effect.sync(() => updates.push(tokens)),
      updateClientInfo: unexpected,
      updateCodeVerifier: unexpected,
      clearCodeVerifier: unexpected,
      updateOAuthState: unexpected,
      getOAuthState: unexpected,
      clearOAuthState: unexpected,
    })
    const provider = new McpOAuthProvider(
      "test-server",
      "https://mcp.example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    await provider.saveTokens({ access_token: "new-access", token_type: "Bearer", expires_in: 3600 })

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ accessToken: "new-access", refreshToken: "old-refresh" })
  })
})
