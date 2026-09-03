import { describe, expect, test } from "bun:test"
import { createLinearIntegration, linearEndpointFetch } from "@/security/integrations/linear"
import { SecurityRegistry } from "@/security/registry"

const context = {
  workspace: "/workspace",
  cacheDir: "/cache",
  secrets: { LINEAR_API_KEY: "linear-test-key" },
}

const request = {
  signal: new AbortController().signal,
  progress: () => Promise.resolve(),
}

describe("Linear agent integration", () => {
  test("qualifies Linear traffic through the shared redirect-rejecting policy boundary", async () => {
    const requests: Array<{ url: string; addresses: readonly string[]; redirect?: RequestRedirect }> = []
    const fetch = await linearEndpointFetch({
      now: () => 1_000,
      resolve: async () => ["93.184.216.34"],
      request: async (url, init, addresses) => {
        requests.push({ url: url.toString(), addresses, redirect: init.redirect })
        return new Response(null, { status: 302 })
      },
    })

    await expect(fetch("https://mcp.linear.app/mcp")).rejects.toThrow("redirects are prohibited")
    expect(requests).toEqual([
      {
        url: "https://mcp.linear.app/mcp",
        addresses: ["93.184.216.34"],
        redirect: "manual",
      },
    ])
  })

  test("is registered behind the single managed MCP server", () => {
    const linear = SecurityRegistry.integration("linear")
    expect(linear?.category).toBe("agent-tools")
    expect(linear?.secrets).toEqual(["LINEAR_API_KEY"])
    expect(linear?.tools.map((tool) => tool.name)).toEqual(["linear_tools", "linear_call"])
  })

  test("loads upstream metadata on demand, reuses it, then unloads the connection", async () => {
    let connections = 0
    let listings = 0
    let closes = 0
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const integration = createLinearIntegration(async (key) => {
      connections++
      expect(key).toBe("linear-test-key")
      return {
        listTools: async () => {
          listings++
          return {
            tools: [
              {
                name: "create_issue",
                description: "Create a new issue in a Linear team",
                inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
              },
              {
                name: "list_projects",
                description: "List projects in a Linear workspace",
                inputSchema: { type: "object" },
              },
            ],
          }
        },
        callTool: async (name, args) => {
          calls.push({ name, args })
          return { content: [{ type: "text", text: "created" }] }
        },
        close: async () => {
          closes++
        },
      }
    }, 5)
    const search = integration.tools.find((tool) => tool.name === "linear_tools")
    const call = integration.tools.find((tool) => tool.name === "linear_call")
    if (!search || !call) throw new Error("Linear broker tools are missing")

    expect(connections).toBe(0)
    expect(await search.handler({ query: "create issue" }, context, request)).toEqual({
      query: "create issue",
      matches: [
        {
          name: "create_issue",
          description: "Create a new issue in a Linear team",
          inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        },
      ],
    })
    expect(await call.handler({ tool: "create_issue", arguments: { title: "Test" } }, context, request)).toEqual({
      content: [{ type: "text", text: "created" }],
    })
    expect(connections).toBe(1)
    expect(listings).toBe(1)
    expect(calls).toEqual([{ name: "create_issue", args: { title: "Test" } }])

    await Bun.sleep(15)
    expect(closes).toBe(1)
  })

  test("does not connect without a configured key", async () => {
    let connections = 0
    const integration = createLinearIntegration(async () => {
      connections++
      throw new Error("should not connect")
    })
    const search = integration.tools.find((tool) => tool.name === "linear_tools")
    if (!search) throw new Error("Linear search tool is missing")

    await expect(search.handler({ query: "issues" }, { ...context, secrets: {} }, request)).rejects.toThrow(
      "API key is not configured",
    )
    expect(connections).toBe(0)
  })

  test("never reuses a connection across credentials", async () => {
    const connected: string[] = []
    const integration = createLinearIntegration(async (key) => {
      connected.push(key)
      return {
        listTools: async () => ({
          tools: [
            {
              name: "list_issues",
              description: `List issues for ${key}`,
              inputSchema: { type: "object" },
            },
          ],
        }),
        callTool: async () => ({ key }),
        close: async () => {},
      }
    })
    const search = integration.tools.find((tool) => tool.name === "linear_tools")
    if (!search) throw new Error("Linear search tool is missing")

    const [first, second] = await Promise.all([
      search.handler({ query: "issues" }, { ...context, secrets: { LINEAR_API_KEY: "key-a" } }, request),
      search.handler({ query: "issues" }, { ...context, secrets: { LINEAR_API_KEY: "key-b" } }, request),
    ])

    expect(connected.sort()).toEqual(["key-a", "key-b"])
    expect(JSON.stringify(first)).toContain("key-a")
    expect(JSON.stringify(second)).toContain("key-b")
  })

  test("contains idle close failures", async () => {
    const integration = createLinearIntegration(
      async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({}),
        close: async () => {
          throw new Error("close failed")
        },
      }),
      1,
    )
    const search = integration.tools.find((tool) => tool.name === "linear_tools")
    if (!search) throw new Error("Linear search tool is missing")

    await search.handler({ query: "issues" }, context, request)
    await Bun.sleep(10)
  })
})
