import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { ProviderConnectionPolicy } from "@/provider/connection-policy"
import { classifyAddress } from "@/util/ip-address"
import type { Integration } from "../registry"
import { ToolError } from "../types"

const linearContribution = ExtensionCatalog.contribution("security:linear")
if (linearContribution?.type !== "mcp" || linearContribution.deployment.type !== "hosted") {
  throw new Error("Missing hosted MCP deployment for adapter: security:linear")
}
const ENDPOINT = linearContribution.deployment.url
const TIMEOUT_MS = 30_000
const IDLE_MS = 60_000
const MAX_LIST_PAGES = 100
const MAX_TOOLS = 1_000
const MAX_MATCHES = 6
const MAX_DESCRIPTION_CHARS = 500
const MAX_SCHEMA_CHARS = 8_000
type PolicyFetch = {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  close: () => void
}

interface LinearClient {
  listTools(cursor?: string): Promise<{ tools: Tool[]; nextCursor?: string }>
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

interface ActiveClient {
  client: LinearClient
  tools?: Tool[]
  uses: number
  idle?: ReturnType<typeof setTimeout>
}

export function createLinearIntegration(
  connect: (key: string) => Promise<LinearClient> = connectLinear,
  idleMs = IDLE_MS,
): Integration {
  const clients = new Map<string, ActiveClient>()
  const connecting = new Map<string, Promise<ActiveClient>>()

  const useClient = async <A>(key: string, use: (state: ActiveClient) => Promise<A>) => {
    const credential = createHash("sha256").update(key).digest("hex")
    const pending = connecting.get(credential)
    const state =
      clients.get(credential) ??
      (await (pending ??
        (() => {
          const created = connect(key)
            .then((client): ActiveClient => ({ client, uses: 0 }))
            .then((client) => {
              clients.set(credential, client)
              return client
            })
            .finally(() => connecting.delete(credential))
          connecting.set(credential, created)
          return created
        })()))
    if (state.idle) {
      clearTimeout(state.idle)
      state.idle = undefined
    }
    state.uses++
    try {
      return await use(state)
    } finally {
      state.uses--
      if (state.uses === 0) {
        state.idle = setTimeout(() => {
          if (clients.get(credential) !== state) return
          clients.delete(credential)
          state.idle = undefined
          void state.client.close().catch(() => {})
        }, idleMs)
        state.idle.unref?.()
      }
    }
  }

  const tools = async (state: ActiveClient) => {
    if (state.tools) return state.tools
    const result: Tool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await state.client.listTools(cursor)
      result.push(...listed.tools)
      if (result.length > MAX_TOOLS) throw new ToolError(`Linear MCP advertised more than ${MAX_TOOLS} tools`)
      if (!listed.nextCursor) {
        state.tools = result
        return result
      }
      if (cursors.has(listed.nextCursor)) throw new ToolError("Linear MCP returned a repeated tool-list cursor")
      cursors.add(listed.nextCursor)
      cursor = listed.nextCursor
    }
    throw new ToolError(`Linear MCP tool listing exceeded ${MAX_LIST_PAGES} pages`)
  }

  const key = (secrets: Record<string, string>) => {
    const value = secrets.LINEAR_API_KEY
    if (value) return value
    throw new ToolError("Linear is enabled but its API key is not configured. Add it in Agent Integrations > Tools.")
  }

  return {
    id: "linear",
    category: "agent-tools",
    description: "Search and update Linear issues, projects, cycles, and teams through Linear's official MCP server",
    secrets: ["LINEAR_API_KEY"],
    tools: [
      {
        name: "linear_tools",
        description:
          "Find Linear capabilities on demand. Returns only matching upstream tool names, descriptions, and input schemas to keep context small.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: 'Capability to find, for example "create issue" or "project status"',
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : ""
          if (!query) throw new ToolError('"query" is required, for example "create issue"')
          return useClient(key(ctx.secrets), async (state) => {
            const terms = query.split(/\s+/).filter(Boolean)
            const matches = (await tools(state))
              .map((tool) => ({
                tool,
                score: terms.reduce((score, term) => {
                  const name = tool.name.toLowerCase()
                  const description = tool.description?.toLowerCase() ?? ""
                  return score + (name.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0)
                }, 0),
              }))
              .filter((item) => item.score > 0)
              .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
              .slice(0, MAX_MATCHES)
              .map((item) => {
                const schema = JSON.stringify(item.tool.inputSchema)
                return {
                  name: item.tool.name,
                  description: item.tool.description?.slice(0, MAX_DESCRIPTION_CHARS),
                  ...(schema.length <= MAX_SCHEMA_CHARS
                    ? { inputSchema: item.tool.inputSchema }
                    : { schemaOmitted: true, schemaBytes: Buffer.byteLength(schema) }),
                }
              })
            return { query, matches }
          })
        },
      },
      {
        name: "linear_call",
        description:
          "Call one Linear capability returned by linear_tools. Use linear_tools first so the exact name and arguments are known. Linear capabilities may read or modify workspace data.",
        inputSchema: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Exact upstream tool name returned by linear_tools" },
            arguments: { type: "object", description: "Arguments matching that tool's input schema" },
          },
          required: ["tool"],
          additionalProperties: false,
        },
        handler: async (args, ctx, request) => {
          const name = typeof args.tool === "string" ? args.tool.trim() : ""
          if (!name) throw new ToolError('"tool" is required; call linear_tools to discover it')
          if (
            args.arguments !== undefined &&
            (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments))
          ) {
            throw new ToolError('"arguments" must be an object')
          }
          return useClient(key(ctx.secrets), async (state) => {
            if (!(await tools(state)).some((tool) => tool.name === name)) {
              throw new ToolError(`unknown Linear tool "${name}"; call linear_tools to discover available capabilities`)
            }
            return state.client.callTool(name, (args.arguments ?? {}) as Record<string, unknown>, request.signal)
          })
        },
      },
    ],
  }
}

async function connectLinear(key: string): Promise<LinearClient> {
  let policyFetch: PolicyFetch | undefined
  let transport: StreamableHTTPClientTransport | undefined
  try {
    policyFetch = await linearEndpointFetch()
    const client = new Client({ name: "forge", version: InstallationVersion }, { capabilities: {} })
    transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
      fetch: policyFetch,
    })
    await client.connect(transport, { timeout: TIMEOUT_MS })
    return {
      listTools: (cursor) => client.listTools(cursor ? { cursor } : undefined, { timeout: TIMEOUT_MS }),
      callTool: (name, args, signal) =>
        client.callTool({ name, arguments: args }, CallToolResultSchema, {
          timeout: TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          signal,
          onprogress: () => {},
        }),
      close: async () => {
        try {
          await client.close()
        } finally {
          policyFetch?.close()
        }
      },
    }
  } catch (error) {
    policyFetch?.close()
    await transport?.close().catch(() => {})
    throw new ToolError(`Could not connect to Linear MCP: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function linearEndpointFetch(dependencies?: ProviderConnectionPolicy.ConnectionPolicyDependencies) {
  return ProviderConnectionPolicy.createConnectionPolicyFetchForEndpoint(
    {
      id: "extension-mcp:linear",
      endpoint: ENDPOINT,
      noAddressesMessage: "Linear MCP endpoint DNS returned no addresses",
      validateAddresses: (addresses) => assertPublicAddresses(addresses),
    },
    dependencies,
  )
}

function assertPublicAddresses(addresses: readonly string[]) {
  const classes = new Set(addresses.map((address) => classifyAddress(address.toLowerCase())))
  if (classes.size !== 1 || !classes.has("public")) throw new ToolError("Linear MCP endpoint must resolve publicly")
}

export const Linear = createLinearIntegration()
