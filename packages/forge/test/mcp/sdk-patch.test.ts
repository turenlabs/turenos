import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { determineScope } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

describe("MCP SDK patch", () => {
  test("adds offline access only when refresh tokens are supported", () => {
    const options = {
      requestedScope: "resource.read",
      authServerMetadata: {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"],
        scopes_supported: ["resource.read", "offline_access"],
      },
      clientMetadata: { redirect_uris: [], grant_types: ["refresh_token"] },
    }
    expect(determineScope(options)).toBe("resource.read offline_access")
    expect(determineScope({ ...options, clientMetadata: { redirect_uris: [] } })).toBe("resource.read")
  })

  test("keeps output validators from earlier tool pages", async () => {
    const server = new Server({ name: "pagination", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
      tools: [
        {
          name: request.params?.cursor ? "second" : "first",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        },
      ],
      ...(request.params?.cursor ? {} : { nextCursor: "page-2" }),
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [],
      structuredContent: { value: 123 },
    }))
    const transports = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "pagination-test", version: "1" })
    try {
      await server.connect(transports[0])
      await client.connect(transports[1])
      const page = await client.listTools()
      await client.listTools({ cursor: page.nextCursor })
      await expect(client.callTool({ name: "first" })).rejects.toThrow("Structured content does not match")
    } finally {
      await client.close()
      await server.close()
    }
  })

  test("does not follow a cross-origin redirect during initialization", async () => {
    let requests = 0
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return new Response("unexpected target request", { status: 500 })
      },
    })
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 307, headers: { location: target.url.href } }),
    })
    const client = new Client({ name: "redirect-test", version: "1" })
    try {
      await expect(client.connect(new StreamableHTTPClientTransport(redirect.url))).rejects.toThrow()
      expect(requests).toBe(0)
    } finally {
      await client.close()
      redirect.stop(true)
      target.stop(true)
    }
  })
})
