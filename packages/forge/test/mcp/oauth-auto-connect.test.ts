import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { AgentV2 } from "@turenlabs/core/agent"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Database } from "@turenlabs/core/database/database"
import { EventV2 } from "@turenlabs/core/event"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Project } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTerminal } from "@turenlabs/core/session/terminal"
import { HandoffTool } from "@turenlabs/core/tool/handoff"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { SessionToolSnapshot } from "@turenlabs/core/tool/session-snapshot"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { McpAuth } from "../../src/mcp/auth"
import { MCP } from "../../src/mcp/index"
import { McpIntegration } from "../../src/mcp/integration"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { McpOAuthAutoProvider, McpOAuthPendingProvider, McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { McpBroker } from "../../src/mcp/broker"
import { testEffect } from "../lib/effect"

const mcpTest = testEffect(
  LayerNode.compile(
    LayerNode.group([MCP.testNode, McpAuth.node, EventV2Bridge.node, Config.node, CrossSpawnSpawner.node, FSUtil.node]),
  ),
)

interface OAuthMcpOptions {
  capabilities?: "tools" | "resources"
  unauthorizedDelay?: number
  tokenDelay?: number
}

function serveOAuthMcp(options: OAuthMcpOptions = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const capabilities = options.capabilities ?? "tools"
      const protocol = new Server(
        { name: "oauth-auto-connect", version: "1.0.0" },
        { capabilities: capabilities === "tools" ? { tools: {} } : { resources: {} } },
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      let listToolsCalls = 0
      let requiresAuth = true

      if (capabilities === "tools") {
        protocol.setRequestHandler(ListToolsRequestSchema, () => {
          listToolsCalls++
          return Promise.resolve({ tools: [{ name: "test_tool", inputSchema: { type: "object" } }] })
        })
        protocol.setRequestHandler(CallToolRequestSchema, (request) =>
          Promise.resolve({ content: [{ type: "text", text: `fake:${request.params.name}` }] }),
        )
      }
      if (capabilities === "resources") {
        protocol.setRequestHandler(ListResourcesRequestSchema, () =>
          Promise.resolve({ resources: [{ name: "docs", uri: "docs://readme" }] }),
        )
      }

      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const origin = url.origin
          const mcpUrl = `${origin}/mcp`

          if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            return Response.json({
              resource: mcpUrl,
              authorization_servers: [origin],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/.well-known/oauth-protected-resource") {
            return Response.json({
              resource: mcpUrl,
              authorization_servers: [origin],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/register") {
            const metadata = (await request.json()) as Record<string, unknown>
            return Response.json({ ...metadata, client_id: "replacement-client" }, { status: 201 })
          }
          if (url.pathname === "/token") {
            const body = new URLSearchParams(await request.text())
            if (body.get("code") !== "valid-code") {
              return Response.json(
                { error: "invalid_grant", error_description: "Token exchange failed" },
                { status: 400 },
              )
            }
            if (options.tokenDelay) await Bun.sleep(options.tokenDelay)
            return Response.json({ access_token: "replacement-token", token_type: "Bearer" })
          }
          if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })

          if (request.method === "GET") return new Response(null, { status: 405 })
          if (requiresAuth && request.headers.get("authorization") !== "Bearer replacement-token") {
            if (options.unauthorizedDelay) await Bun.sleep(options.unauthorizedDelay)
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp"`,
              },
            })
          }
          return transport.handleRequest(request)
        },
      })

      return {
        url: new URL("/mcp", http.url).toString(),
        allowAnonymous: () => {
          requiresAuth = false
        },
        listToolsCalls: () => listToolsCalls,
        close: async () => {
          await http.stop(true)
          await protocol.close()
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const remote = (url: string, enabled = true) => ({
  type: "remote" as const,
  url,
  enabled,
})

let v2HostedStatus: "needs-auth" | "connected" | "disabled" = "needs-auth"

const v2Source = Layer.succeed(
  McpTool.Source,
  McpTool.Source.of({
    list: () =>
      Effect.succeed(
        v2HostedStatus === "connected"
          ? [
              {
                key: "v2-oauth_test_tool",
                server: "v2-oauth",
                name: "test_tool",
                description: "A fake hosted tool",
                maxLoadedTools: 4,
                unloadAfterIdleTurns: 3,
                inputSchema: { type: "object", properties: {} },
                call: () => Effect.succeed({ content: [{ type: "text", text: "fake:test_tool" }] }),
              } satisfies McpTool.Definition,
            ]
          : [],
      ),
    inventory: (_input) => {
      const connected = v2HostedStatus === "connected"
      const exclusionReason = v2HostedStatus === "disabled" ? ("disabled" as const) : ("needs-auth" as const)
      const capability = {
        key: "v2-oauth_test_tool",
        server: "v2-oauth",
        name: "test_tool",
        description: "A fake hosted tool",
        maxLoadedTools: 4,
        unloadAfterIdleTurns: 3,
      }
      return Effect.succeed({
        observedAt: Date.now(),
        servers: [
          {
            id: "v2-oauth",
            status: v2HostedStatus,
            definitions: connected ? 1 : 0,
          },
        ],
        capabilities: connected ? [capability] : [],
        exclusions: connected ? [] : [{ server: "v2-oauth", reason: exclusionReason }],
      } satisfies McpTool.Inventory)
    },
    begin: (input) => Effect.succeed(McpBroker.beginTurn(input.sessionID, input.capabilities, input.directory)),
    selected: (input) =>
      Effect.succeed(McpBroker.selected(input.sessionID, input.capabilities, input.directory).map((item) => item.key)),
    search: (input) =>
      Effect.succeed(McpBroker.search(input.sessionID, input.capabilities, input.query, input.directory)),
    load: (input) =>
      Effect.try({
        try: () => McpBroker.load(input.sessionID, input.capabilities, input.tools, input.directory),
        catch: (error) => new Tool.Failure({ message: error instanceof Error ? error.message : String(error) }),
      }),
    touch: (input) => Effect.sync(() => McpBroker.touch(input.sessionID, input.key, input.directory)),
  }),
)

const v2McpTest = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionToolProvider.node,
      McpTool.node,
      SessionToolSnapshot.node,
      MCP.testNode,
      McpAuth.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
    ]),
    [
      [McpTool.sourceNode, v2Source],
      [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make("/tmp"),
            project: { id: Project.ID.global, directory: AbsolutePath.make("/tmp") },
          }),
        ),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SubagentTool.node, Layer.mock(SubagentTool.Service, { forExecution: () => Effect.succeed({}) })],
      [HandoffTool.node, Layer.mock(HandoffTool.Service, { forExecution: () => Effect.succeed({}) })],
      [SessionTerminal.node, Layer.mock(SessionTerminal.Service, { get: () => Effect.succeed(undefined) })],
    ],
  ),
)

const stopOAuthCallback = Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

v2McpTest.instance("uses the canonical V2 snapshot after a configured static OAuth connection", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    v2HostedStatus = "needs-auth"
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "v2-oauth"
    const sessionID = SessionSchema.ID.make("ses_v2_oauth_snapshot")
    const agent = AgentV2.ID.make("build")

    const configured = yield* McpIntegration.configuration(
      "microsoft-graph-enterprise",
      { clientId: "fixture-client" },
      { MICROSOFT_GRAPH_CLIENT_SECRET: "fixture-client-secret" },
    )
    if (!configured || configured.type !== "remote") throw new Error("Expected a configured static OAuth MCP")
    const added = yield* mcp.add(name, { ...configured, url: server.url })
    expect(added.candidate.status).toBe("needs_auth")
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("client_id=fixture-client")
    expect(started.authorizationUrl).toContain("/authorize")
    expect((yield* mcp.finishAuth(name, "valid-code")).status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual([`${name}_test_tool`])
    v2HostedStatus = "connected"

    const snapshots = yield* SessionToolSnapshot.Service
    const testModel = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("fake"),
      id: ModelV2.ID.make("fake-model"),
    })
    const first = yield* snapshots.materialize({
      sessionID,
      directory: AbsolutePath.make("/tmp"),
      model: testModel,
      agent,
    })
    const capability = first.snapshot.broker.capabilities.find((item) => item.name === "test_tool")
    expect(capability?.key).toBe(`${name}_test_tool`)
    const key = capability!.key
    expect(first.snapshot.broker.visible).toEqual([McpTool.SEARCH_TOOL_NAME, McpTool.LOAD_TOOL_NAME])

    const settle = (materialization: ToolRegistry.Materialization, name: string, input: unknown, id: string) =>
      materialization.settle({
        sessionID,
        agent,
        assistantMessageID: SessionMessage.ID.make(`msg_${id}`),
        call: { type: "tool-call", id, name, input },
      })
    const search = yield* settle(first.materialization, McpTool.SEARCH_TOOL_NAME, {}, "search")
    expect(search.result.type).toBe("json")
    if (search.result.type === "json") expect(search.result.value).toMatchObject({ available: 1 })

    const loaded = yield* settle(first.materialization, McpTool.LOAD_TOOL_NAME, { tools: [key] }, "load")
    expect(loaded.result.type).not.toBe("error")

    const after = yield* snapshots.materialize({
      sessionID,
      directory: AbsolutePath.make("/tmp"),
      model: testModel,
      agent,
    })
    expect(after.snapshot.visible.map((tool) => tool.id)).toContain(`${name}_test_tool`)
    expect(after.snapshot.broker.loaded).toEqual([`${name}_test_tool`])
    const direct = yield* settle(after.materialization, `${name}_test_tool`, {}, "direct")
    expect(direct.result).toEqual({ type: "text", value: "fake:test_tool" })

    yield* mcp.disconnect(name)
    v2HostedStatus = "disabled"
    const disabled = yield* snapshots.materialize({
      sessionID,
      directory: AbsolutePath.make("/tmp"),
      model: testModel,
      agent,
    })
    expect(disabled.snapshot.visible.map((tool) => tool.id)).not.toContain(`${name}_test_tool`)
    expect(disabled.snapshot.exclusions).toContainEqual({ server: name, reason: "disabled" })
  }),
)

mcpTest.instance("first connect to OAuth server shows needs_auth instead of failed", () =>
  Effect.gen(function* () {
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("test-oauth", remote(server.url))

    expect((result.status as Record<string, { status: string }>)["test-oauth"]).toEqual({ status: "needs_auth" })
  }),
)

mcpTest.instance("serializes concurrent split OAuth starts", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ unauthorizedDelay: 50 })
    const mcp = yield* MCP.Service
    yield* mcp.add("split-oauth", remote(server.url))

    const results = yield* Effect.all(
      [mcp.startAuth("split-oauth").pipe(Effect.exit), mcp.startAuth("split-oauth").pipe(Effect.exit)],
      { concurrency: "unbounded" },
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)

    yield* mcp.removeAuth("split-oauth")
  }),
)

mcpTest.instance("logout closes the active client and removes its tools", () =>
  Effect.gen(function* () {
    const server = yield* serveOAuthMcp()
    server.allowAnonymous()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    yield* auth.set("logout-oauth", { tokens: { accessToken: "replacement-token" } }, server.url)
    yield* mcp.add("logout-oauth", remote(server.url))
    expect((yield* mcp.status())["logout-oauth"]?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["logout-oauth_test_tool"])

    yield* mcp.removeAuth("logout-oauth")

    expect((yield* mcp.status())["logout-oauth"]?.status).toBe("needs_auth")
    expect(yield* mcp.tools()).toEqual({})
    expect(yield* auth.get("logout-oauth")).toBeUndefined()
  }),
)

mcpTest.instance("logout waits for an in-flight OAuth callback and removes its result", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ tokenDelay: 100 })
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    yield* mcp.add("callback-logout", remote(server.url))
    yield* mcp.startAuth("callback-logout")

    const finishing = yield* mcp.finishAuth("callback-logout", "valid-code").pipe(Effect.forkChild)
    yield* Effect.sleep("20 millis")
    yield* mcp.removeAuth("callback-logout")
    expect((yield* Fiber.join(finishing)).status).toBe("connected")

    expect((yield* mcp.status())["callback-logout"]?.status).toBe("needs_auth")
    expect(yield* mcp.tools()).toEqual({})
    expect(yield* auth.get("callback-logout")).toBeUndefined()
  }),
)

mcpTest.instance("interrupted token completion releases the pending OAuth transport", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ tokenDelay: 1_000 })
    const mcp = yield* MCP.Service
    const name = "interrupted-completion"
    yield* mcp.add(name, remote(server.url))
    expect((yield* mcp.startAuth(name)).authorizationUrl).toContain("/authorize")

    const finishing = yield* mcp.finishAuth(name, "valid-code").pipe(Effect.forkChild)
    yield* Effect.sleep("20 millis")
    yield* Fiber.interrupt(finishing)

    expect((yield* mcp.startAuth(name)).authorizationUrl).toContain("/authorize")
    yield* mcp.removeAuth(name)
  }),
)

mcpTest.instance("state() generates and persists a new state when none is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-gen",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    expect((yield* auth.get("test-state-gen"))?.oauthState).toBeUndefined()

    const state = yield* Effect.promise(() => provider.state())
    expect(state).toHaveLength(64)
    expect((yield* auth.get("test-state-gen"))?.oauthState).toBe(state)
  }),
)

mcpTest.instance("state() returns existing state when one is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-existing",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    yield* auth.updateOAuthState("test-state-existing", "pre-saved-state-value")
    expect(yield* Effect.promise(() => provider.state())).toBe("pre-saved-state-value")
  }),
)

mcpTest.instance("pending provider does not expose or overwrite existing credentials before commit", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const name = "test-pending-credentials"
    const url = "https://example.com/mcp"
    const provider = new McpOAuthPendingProvider(name, url, {}, { onRedirect: async () => {} }, auth)

    yield* auth.updateClientInfo(name, { clientId: "old-client" }, url)
    yield* auth.updateTokens(name, { accessToken: "old-token" }, url)

    expect(yield* Effect.promise(() => provider.clientInformation())).toBeUndefined()
    expect(yield* Effect.promise(() => provider.tokens())).toBeUndefined()
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("old-token")
    expect((yield* auth.get(name))?.clientInfo?.clientId).toBe("old-client")
  }),
)

mcpTest.instance("failed reauthentication preserves existing credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-reauth-failure"

    yield* auth.updateClientInfo(name, { clientId: "dynamic-client", clientSecret: "dynamic-secret" }, server.url)
    yield* auth.updateTokens(name, { accessToken: "working-token" }, server.url)
    yield* mcp.add(name, remote(server.url))
    expect((yield* mcp.startAuth(name)).authorizationUrl).toContain("/authorize")

    expect(yield* mcp.finishAuth(name, "invalid-code")).toEqual({
      status: "failed",
      error: "OAuth completion failed: Token exchange failed",
    })
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("working-token")
    expect((yield* auth.get(name))?.clientInfo).toMatchObject({
      clientId: "dynamic-client",
      clientSecret: "dynamic-secret",
    })

    expect((yield* mcp.startAuth(name)).authorizationUrl).toContain("/authorize")
    yield* mcp.removeAuth(name)
  }),
)

mcpTest.instance("successful reauthentication commits replacement credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-reauth-success"

    yield* auth.updateClientInfo(name, { clientId: "old-client" }, server.url)
    yield* auth.updateTokens(name, { accessToken: "old-token" }, server.url)
    yield* mcp.add(name, remote(server.url))
    expect((yield* mcp.startAuth(name)).authorizationUrl).toContain("/authorize")
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("old-token")

    expect((yield* mcp.finishAuth(name, "valid-code")).status).toBe("connected")
    const entry = yield* auth.get(name)
    expect(entry?.tokens?.accessToken).toBe("replacement-token")
    expect(entry?.clientInfo?.clientId).toBe("replacement-client")
    expect(entry?.serverUrl).toBe(server.url)
  }),
)

// `MCP.Service` state is per directory but `McpAuth` storage is process-global, so one
// ordinary connect runs per open directory for the same server. None of them may fence
// the others off the credentials they are all sharing.
mcpTest.instance("an ordinary reconnect does not fence a live connection's credentials", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const name = "test-reconnect-fencing"
    const url = "https://example.com/mcp"
    yield* auth.set(name, { tokens: { accessToken: "stored-token" } }, url)

    const first = yield* auth.generationForUrl(name, url)
    const provider = new McpOAuthAutoProvider(name, url, {}, { onRedirect: async () => {} }, auth, first)
    expect((yield* Effect.promise(() => provider.tokens()))?.access_token).toBe("stored-token")

    // A second directory opens and connects the same server.
    const second = yield* auth.generationForUrl(name, url)
    expect(second).toBe(first)
    const sibling = new McpOAuthAutoProvider(name, url, {}, { onRedirect: async () => {} }, auth, second)
    expect((yield* Effect.promise(() => sibling.tokens()))?.access_token).toBe("stored-token")

    // The first connection must still read its credentials rather than be fenced off
    // them, and must still be allowed to persist a refreshed token.
    expect((yield* Effect.promise(() => provider.tokens()))?.access_token).toBe("stored-token")
    yield* Effect.promise(() => provider.saveTokens({ access_token: "refreshed-token", token_type: "Bearer" }))
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("refreshed-token")
  }),
)

mcpTest.instance("a background connect does not clobber an in-flight interactive authorization", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-connect-during-auth"
    yield* mcp.add(name, remote(server.url))

    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")
    const verifier = (yield* auth.get(name))?.codeVerifier
    expect(verifier).toBeTruthy()

    // A sibling directory boots and connects the same server while the browser
    // round-trip is still outstanding.
    yield* mcp.connect(name)

    const attempt = yield* auth.get(name)
    expect(attempt?.oauthState).toBe(started.oauthState)
    expect(attempt?.codeVerifier).toBe(verifier)

    // The interactive authorization still owns the pending transport and provider.
    expect(Exit.isFailure(yield* mcp.startAuth(name).pipe(Effect.exit))).toBe(true)

    expect((yield* mcp.finishAuth(name, "valid-code")).status).toBe("connected")
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("replacement-token")
  }),
)

mcpTest.instance("auth status only reports credentials stored for the configured server URL", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("test-status-url", remote("https://example.com/mcp", false))
    yield* McpAuth.use.updateTokens("test-status-url", { accessToken: "old-token" }, "https://old.example.com/mcp")

    expect(yield* mcp.getAuthStatus("test-status-url")).toBe("not_authenticated")

    yield* McpAuth.use.prepareForUrl("test-status-url", "https://example.com/mcp")
    yield* McpAuth.use.updateTokens("test-status-url", { accessToken: "current-token" }, "https://example.com/mcp")
    expect(yield* mcp.getAuthStatus("test-status-url")).toBe("authenticated")

    yield* McpAuth.use.updateTokens(
      "test-status-url",
      { accessToken: "expired-token", expiresAt: 1 },
      "https://example.com/mcp",
    )
    expect(yield* mcp.getAuthStatus("test-status-url")).toBe("expired")
  }),
)

mcpTest.instance("authenticate() stores a connected client when auth completes without redirect", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-connect"
    const added = yield* mcp.add(name, remote(server.url))
    expect((added.status as Record<string, { status: string }>)[name]?.status).toBe("needs_auth")

    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("connected")
    expect((yield* mcp.status())[name]?.status).toBe("connected")
  }),
)

mcpTest.instance("authenticate() connects a resource-only server without listing tools", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ capabilities: "resources" })
    const mcp = yield* MCP.Service
    const name = "test-oauth-resources"
    const added = yield* mcp.add(name, remote(server.url))
    expect((added.status as Record<string, { status: string }>)[name]?.status).toBe("needs_auth")

    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("connected")
    expect(server.listToolsCalls()).toBe(0)
    expect(Object.keys(yield* mcp.resources())).toEqual([`${name}:docs://readme`])
  }),
)
