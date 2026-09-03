import { describe, expect, test } from "bun:test"
import { ConfigMcpLegacyV1 } from "@turenlabs/core/v1/config/mcp-legacy"

const notionUrl = "https://mcp.notion.com/mcp"

describe("ConfigMcpLegacyV1.split", () => {
  test("takes the retired key off and leaves every other key untouched", () => {
    const input = {
      $schema: "https://github.com/turenlabs/forge/config.json",
      model: "anthropic/claude-opus-4",
      permission: { bash: "allow" },
      mcp: { notion: { type: "remote", url: notionUrl } },
    }
    const result = ConfigMcpLegacyV1.split(input)

    expect(result.config).toEqual({
      $schema: "https://github.com/turenlabs/forge/config.json",
      model: "anthropic/claude-opus-4",
      permission: { bash: "allow" },
    })
    expect(result.servers).toEqual({ notion: { type: "remote", url: notionUrl } })
    // The caller's document is not mutated.
    expect(Object.keys(input)).toContain("mcp")
  })

  test("reports the key as present even when its value is malformed", () => {
    expect(ConfigMcpLegacyV1.split({ mcp: "nonsense" })).toEqual({ config: {}, servers: {} })
  })

  test("leaves a document without the key alone", () => {
    const input = { model: "anthropic/claude-opus-4" }
    expect(ConfigMcpLegacyV1.split(input)).toEqual({ config: input })
  })
})

describe("ConfigMcpLegacyV1.classify", () => {
  test("maps a hosted remote url onto the extension that provides it", () => {
    expect(ConfigMcpLegacyV1.classify({ notion: { type: "remote", url: notionUrl } })).toEqual([
      { kind: "enable", name: "notion", extension: "turenlabs/notion", detail: notionUrl },
    ])
  })

  test("matches a hosted url regardless of case and trailing slash", () => {
    expect(ConfigMcpLegacyV1.classify({ n: { type: "remote", url: "https://MCP.Notion.com/mcp/" } })).toMatchObject([
      { kind: "enable", extension: "turenlabs/notion" },
    ])
  })

  test("treats the bundled security server as obsolete rather than recreating it", () => {
    const entries = ConfigMcpLegacyV1.classify({
      "forge-security": {
        type: "local",
        command: ["/Applications/Forge.app/Contents/Resources/forge-cli", "security-mcp"],
      },
    })
    expect(entries).toMatchObject([{ kind: "obsolete", name: "forge-security" }])
    expect(entries[0]!.detail).toContain("security extensions")
  })

  test("recognises the repo and bare-binary spellings of the security server", () => {
    const commands = [
      ["forge-cli", "security-mcp"],
      ["/usr/local/bin/forge", "security-mcp"],
      ["bun", "run", "/repo/packages/forge/src/index.ts", "security-mcp"],
      ["node", "/opt/forge/dist/node/index.js", "security-mcp"],
    ]
    for (const command of commands) expect(ConfigMcpLegacyV1.isBundledSecurityServer(command)).toBe(true)
  })

  test("does not claim a server that merely mentions forge or security-mcp", () => {
    expect(ConfigMcpLegacyV1.isBundledSecurityServer(["/usr/local/bin/forge", "security-mcp", "--inspect"])).toBe(false)
    expect(ConfigMcpLegacyV1.isBundledSecurityServer(["/opt/my-forge-tool", "security-mcp"])).toBe(false)
    expect(ConfigMcpLegacyV1.isBundledSecurityServer(["python3", "watch.py", "security-mcp"])).toBe(false)
  })

  test("flags a remote server no extension provides", () => {
    const entries = ConfigMcpLegacyV1.classify({ acme: { type: "remote", url: "https://mcp.acme.test/sse" } })
    expect(entries).toMatchObject([{ kind: "unmapped", name: "acme" }])
    expect(entries[0]!.detail).toContain("https://mcp.acme.test/sse")
  })

  test("flags a local server no extension provides", () => {
    const entries = ConfigMcpLegacyV1.classify({ tools: { type: "local", command: ["npx", "@acme/mcp"] } })
    expect(entries).toMatchObject([{ kind: "unmapped", name: "tools" }])
    expect(entries[0]!.detail).toContain("npx @acme/mcp")
  })

  test("never activates a server the user had switched off", () => {
    expect(ConfigMcpLegacyV1.classify({ notion: { type: "remote", url: notionUrl, enabled: false } })).toMatchObject([
      { kind: "disabled", name: "notion" },
    ])
  })

  test("keeps a malformed entry as a warning rather than dropping it", () => {
    expect(ConfigMcpLegacyV1.classify({ broken: 7, typeless: { url: notionUrl } })).toMatchObject([
      { kind: "unmapped", name: "broken" },
      { kind: "unmapped", name: "typeless" },
    ])
  })
})

describe("ConfigMcpLegacyV1.dedupe", () => {
  test("lets the last document to name a server win, as every other config key does", () => {
    const entries = ConfigMcpLegacyV1.dedupe([
      { kind: "unmapped", name: "notion", detail: "from the global file" },
      { kind: "enable", name: "notion", extension: "turenlabs/notion", detail: notionUrl },
      { kind: "unmapped", name: "acme", detail: "unknown" },
    ])
    expect(entries).toEqual([
      { kind: "enable", name: "notion", extension: "turenlabs/notion", detail: notionUrl },
      { kind: "unmapped", name: "acme", detail: "unknown" },
    ])
  })
})

describe("ConfigMcpLegacyV1.warnings", () => {
  test("names the server and says where MCP servers live now", () => {
    const warnings = ConfigMcpLegacyV1.warnings(
      ConfigMcpLegacyV1.classify({ acme: { type: "remote", url: "https://mcp.acme.test/sse" } }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"acme"')
    expect(warnings[0]).toContain("https://mcp.acme.test/sse")
    expect(warnings[0]).toContain("Settings > Extensions")
  })

  test("stays quiet about servers it successfully migrated or that were switched off", () => {
    expect(
      ConfigMcpLegacyV1.warnings(
        ConfigMcpLegacyV1.classify({
          notion: { type: "remote", url: notionUrl },
          off: { type: "remote", url: "https://mcp.acme.test/sse", enabled: false },
        }),
      ),
    ).toEqual([])
  })
})
