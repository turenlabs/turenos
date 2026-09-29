import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await Bun.write(pidFile, String(process.pid))
  await new Promise(() => {})
}

// Dies during startup like falcon-mcp does on rejected credentials: a useful
// message on stderr, then a non-zero exit before the MCP handshake.
if (process.argv.includes("--stderr-exit")) {
  process.stderr.write("fixture-fatal: refusing to start without credentials\n", () => process.exit(7))
  await new Promise(() => {})
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => {
  // Survives the handshake, then crashes mid-session after the first tools/list.
  if (process.argv.includes("--crash-after-list")) {
    setTimeout(() => {
      process.stderr.write("fixture-crash: exiting after tool list\n", () => process.exit(9))
    }, 25)
  }
  return Promise.resolve({
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
  })
})

await server.connect(new StdioServerTransport())
