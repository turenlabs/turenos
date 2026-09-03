import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await Bun.write(pidFile, String(process.pid))
  await new Promise(() => {})
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.argv.includes("--environment")
          ? JSON.stringify({
              home: process.env.HOME,
              path: process.env.PATH,
              canary: process.env.FORGE_RUNTIME_SECRET_CANARY,
              secret: process.env.MCP_RUNTIME_SECRET,
            })
          : process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
