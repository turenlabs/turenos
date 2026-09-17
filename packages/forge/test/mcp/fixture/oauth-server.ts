import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { McpOAuthCallback } from "../../../src/mcp/oauth-callback"

interface OAuthMcpOptions {
  capabilities?: "tools" | "resources"
  unauthorizedDelay?: number
  tokenDelay?: number
  /** Fixed origin advertised in OAuth metadata instead of the request origin. */
  advertise?: string
  toolName?: string
}

interface Session {
  protocol: Server
  transport: WebStandardStreamableHTTPServerTransport
}

export function serveOAuthMcp(options: OAuthMcpOptions = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const capabilities = options.capabilities ?? "tools"
      const toolName = options.toolName ?? "test_tool"
      const sessions = new Map<string, Session>()
      let listToolsCalls = 0
      let requiresAuth = true

      // One Server + transport pair per session -- Server accepts a single
      // initialize, so concurrent clients (e.g. multiple open directories) each
      // need their own pair, like a real hosted MCP.
      const connect = async () => {
        const protocol = new Server(
          { name: "oauth-auto-connect", version: "1.0.0" },
          { capabilities: capabilities === "tools" ? { tools: {} } : { resources: {} } },
        )
        const session: Session = {
          protocol,
          transport: new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
              sessions.set(id, session)
            },
            onsessionclosed: (id) => {
              sessions.delete(id)
            },
          }),
        }
        if (capabilities === "tools") {
          protocol.setRequestHandler(ListToolsRequestSchema, () => {
            listToolsCalls++
            return Promise.resolve({ tools: [{ name: toolName, inputSchema: { type: "object" } }] })
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
        await protocol.connect(session.transport)
        return session
      }

      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const origin = options.advertise ?? url.origin
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
          const sessionId = request.headers.get("mcp-session-id")
          const session = sessionId ? sessions.get(sessionId) : request.method === "POST" ? await connect() : undefined
          if (!session) return new Response("Unknown MCP session", { status: 404 })
          return session.transport.handleRequest(request)
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
          for (const session of sessions.values()) {
            await session.transport.close().catch(() => undefined)
            await session.protocol.close().catch(() => undefined)
          }
          sessions.clear()
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

export const stopOAuthCallback = Effect.addFinalizer(() =>
  Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
)
