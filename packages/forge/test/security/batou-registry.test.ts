import { expect, test } from "bun:test"
import { SecurityRegistry } from "@/security/registry"
import { createServer } from "@/security/mcp/server"

test("batou is registered as an automatic tools integration with no MCP tools", () => {
  const batou = SecurityRegistry.integration("batou")
  expect(batou).toBeDefined()
  expect(batou!.category).toBe("tools")
  // Batou runs from the bundled write/edit plugin, so it exposes nothing the
  // model can invoke; the entry exists purely for the settings toggle+status.
  expect(batou!.tools).toEqual([])
  // Descriptions are projected from the Extension v1 catalog, where every
  // manifest splits the product name off into `name` and keeps `description`
  // as a bare capability phrase — so this no longer repeats "Batou". The
  // surfaces that need the identity carry the id alongside it (see
  // security/mcp/server.ts instructions).
  expect(batou!.description).toBe("Run automatic SAST on agent file writes")
})

test("the security MCP server starts cleanly when only batou is enabled", () => {
  const server = createServer({ FORGE_SECURITY_INTEGRATIONS: "batou" })
  expect(server).toBeDefined()
})
