import { describe, expect } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Storage } from "@turenlabs/core/storage"
import { Effect } from "effect"
import { isolatedStdioEnvironment, localProcessEnvironment } from "@/mcp"
import { SecurityStorage } from "@/security/storage"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([Database.node, Storage.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])
const it = testEffect(layer)

describe("security storage", () => {
  it.effect("injects minimal database secrets only into the privately managed security child", () =>
    Effect.gen(function* () {
      const bootstrap = SecurityStorage.bootstrapEntry({
        command: ["/opt/forge", "security-mcp"],
        enabled: true,
      })
      expect(bootstrap.environment).toBeUndefined()

      const inherited = {
        PATH: "/bin",
        AWS_BEARER_TOKEN_BEDROCK: "stored-bedrock-secret",
        AICORE_SERVICE_KEY: "stored-sap-secret",
        FORGE_SECURITY_GITHUB_TOKEN: "inherited-secret",
        FORGE_SECURITY_INTEGRATIONS: "all",
      }
      const databaseEnvironment = {
        FORGE_SECURITY_INTEGRATIONS: "ghsa",
        FORGE_SECURITY_GITHUB_TOKEN: "database-secret",
      }
      expect(localProcessEnvironment("forge-security", bootstrap, databaseEnvironment, inherited, true)).toEqual({
        PATH: "/bin",
        ...databaseEnvironment,
      })
      expect(
        localProcessEnvironment(
          "other",
          { ...bootstrap, environment: { OTHER: "value" } },
          databaseEnvironment,
          inherited,
        ),
      ).toEqual({
        PATH: "/bin",
        OTHER: "value",
      })

      expect(
        localProcessEnvironment(
          "forge-security",
          {
            type: "local",
            command: ["/tmp/exfiltrate"],
            environment: { FORGE_SECURITY_GITHUB_TOKEN: "project-supplied", OTHER: "value" },
          },
          databaseEnvironment,
          inherited,
        ),
      ).toEqual({ PATH: "/bin", OTHER: "value" })
    }),
  )

  it.effect("overrides the MCP SDK's default inherited environment for isolated runtimes", () =>
    Effect.sync(() => {
      const environment = isolatedStdioEnvironment({ MCP_SECRET: "secret" })
      expect(environment).toMatchObject({ MCP_SECRET: "secret", HOME: "", PATH: "" })
      expect(Object.values(environment)).not.toContain(process.env.HOME)
      expect(Object.values(environment)).not.toContain(process.env.PATH)
    }),
  )

  it.effect("persists versioned MCP runtime settings and non-secret Docker qualification", () =>
    Effect.gen(function* () {
      expect(yield* SecurityStorage.mcpRuntimeSettingsFor()).toEqual({
        version: 1,
        backend: "docker",
        localProcess: { enabled: false },
      })
      yield* SecurityStorage.mcpRuntimeSettingsSet({ backend: "local" })
      expect(yield* SecurityStorage.mcpRuntimeSettingsFor()).toEqual({
        version: 1,
        backend: "local",
        localProcess: { enabled: true },
      })
      expect(yield* SecurityStorage.mcpRuntimeSettingsUpdate({ backend: "local" })).toMatchObject({
        changed: false,
        settings: { backend: "local" },
      })
      expect(yield* SecurityStorage.mcpRuntimeSettingsUpdate({ backend: "docker" })).toMatchObject({
        changed: true,
        settings: { backend: "docker", localProcess: { enabled: true } },
      })
      yield* SecurityStorage.mcpRuntimeDockerQualificationSet({
        status: "qualified",
        checkedAt: 1_000,
        expiresAt: 2_000,
        revision: 1,
        executable: "/usr/local/bin/docker",
        version: "28.0",
        capabilities: ["network-none"],
      })
      expect(yield* SecurityStorage.mcpRuntimeDockerQualificationFor()).toMatchObject({
        status: "qualified",
        executable: "/usr/local/bin/docker",
        capabilities: ["network-none"],
      })
    }),
  )
})
