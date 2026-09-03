import { cmd } from "./cmd"

/**
 * Internal command: starts the "TurenOS Security" stdio MCP server. Spawned by
 * the forge MCP client via a local MCP config entry (see
 * src/security/CONVENTIONS.md); hidden from `forge --help`.
 *
 * stdout is the MCP JSON-RPC wire — nothing else may write to it.
 */
export const SecurityMcpCommand = cmd({
  command: "security-mcp",
  describe: false,
  async handler() {
    const { runSecurityMcpServer } = await import("@/security/mcp/server")
    const { SecurityRegistry } = await import("@/security/registry")
    const environment =
      process.env[SecurityRegistry.INTEGRATIONS_ENV] === undefined
        ? { ...process.env, [SecurityRegistry.INTEGRATIONS_ENV]: "" }
        : process.env
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(signal, () => process.exit(0))
    }
    await runSecurityMcpServer(environment)
    // Orphaned children were observed spinning at 99% CPU with a dead parent:
    // once the wire is gone this process has no remaining purpose, and there is
    // no work left to drain, so leave immediately rather than trusting the
    // event loop to run dry.
    process.exit(0)
  },
})
