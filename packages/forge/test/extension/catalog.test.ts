import { describe, expect, test } from "bun:test"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { SecurityRegistry } from "../../src/security/registry"
import { McpIntegration } from "../../src/mcp/integration"

describe("Extension v1 runtime migration", () => {
  test("every managed security runtime is owned by exactly one catalog contribution", () => {
    for (const integration of SecurityRegistry.INTEGRATIONS) {
      const contribution = ExtensionCatalog.contribution(`security:${integration.id}`)
      expect(contribution, integration.id).toBeDefined()
      expect(contribution?.description).toBe(integration.description)
      expect(contribution?.secrets.map((secret) => secret.id)).toEqual(integration.secrets ?? [])
      expect(contribution?.type === "tool" ? contribution.commands.toSorted() : []).toEqual(
        [...(integration.executables ?? [])].toSorted(),
      )
    }
  })

  test("every curated MCP runtime is catalog-owned and uses catalog tool policy", () => {
    for (const definition of McpIntegration.Definitions) {
      const manifest = ExtensionCatalog.forAdapter(`mcp:${definition.id}`)
      const contribution = ExtensionCatalog.contribution(`mcp:${definition.id}`)
      expect(manifest?.contributions.some((item) => item.name === definition.name)).toBe(true)
      expect(contribution?.type).toBe("mcp")
      if (contribution?.type !== "mcp") continue
      for (const tool of contribution.tools.allow) {
        expect(McpIntegration.allowsTool(definition.id, tool, { writeTools: "enabled" })).toBe(true)
        expect(McpIntegration.allowsTool(definition.id, tool)).toBe(!contribution.tools.write.includes(tool))
      }
      expect(McpIntegration.allowsTool(definition.id, "unreviewed_tool")).toBe(false)
    }
  })

  test("the embedded customization skill is catalog-owned", () => {
    expect(ExtensionCatalog.contribution("skill:customize-forge")).toMatchObject({
      type: "skill",
      source: { type: "embedded", name: "customize-forge" },
    })
  })
})
