import { expect, setDefaultTimeout } from "bun:test"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { EventV2 } from "@turenlabs/core/event"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Storage } from "@turenlabs/core/storage"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Extension } from "@turenlabs/schema"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp/index"
import { ExtensionObservation } from "../../src/extension/observation"
import { McpAuth } from "../../src/mcp/auth"
import { McpIntegration } from "../../src/mcp/integration"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { serveFalconApi } from "./fixture/falcon-api"

/**
 * End-to-end coverage for the managed CrowdStrike Falcon integration without
 * real credentials: a mock Falcon API stands in for the cloud and the real
 * pinned `uv tool run falcon-mcp==0.19.0` package is spawned by the managed
 * runtime. Needs network access to PyPI on first run, so it is opt-in:
 *
 *   TUREN_FALCON_MCP_E2E=1 bun test test/mcp/falcon-mock.manual.test.ts
 */
const enabled = process.env.TUREN_FALCON_MCP_E2E === "1"
const FALCON_ID = "turenlabs/crowdstrike-falcon"
const NAME = "crowdstrike-falcon"

setDefaultTimeout(10 * 60 * 1000)

// Clone the real catalog manifest but drop the `options` list on baseUrl: the
// published allowlist rightly restricts the field to the public Falcon clouds,
// and the fixture needs a loopback URL to stand in for them.
const falcon = (() => {
  const source = ExtensionCatalog.get(FALCON_ID)
  if (!source) throw new Error("catalog is missing the CrowdStrike Falcon manifest")
  return new Extension.Manifest({
    ...source,
    contributions: source.contributions.map((contribution) =>
      contribution.type !== "mcp"
        ? contribution
        : {
            ...contribution,
            configuration: (contribution.configuration ?? []).map((field) =>
              field.id === "baseUrl"
                ? {
                    id: field.id,
                    label: field.label,
                    required: field.required,
                    ...(field.default === undefined ? {} : { default: field.default }),
                  }
                : field,
            ),
          },
    ),
  })
})()

const api = { url: "" }

const harness = testEffect(
  LayerNode.compile(LayerNode.group([MCP.testNode, McpAuth.node, EventV2.node, CrossSpawnSpawner.node, Storage.node]), [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, {
        manifests: () => Effect.succeed([...ExtensionCatalog.manifests, falcon]),
        enabled: (id) => Effect.succeed(String(id) === FALCON_ID),
        desired: (id) =>
          Effect.succeed(
            String(id) === FALCON_ID ? { enabled: true, configuration: { baseUrl: api.url }, revision: 1 } : undefined,
          ),
        configuration: () => Effect.succeed({ baseUrl: api.url }),
        secret: () => Effect.succeed("falcon-mock-credential"),
        secretsSet: () => Effect.succeed({}),
      }),
    ],
  ]),
)

const register = enabled ? harness.instance : harness.instance.skip

const statusOf = Effect.fnUntraced(function* () {
  const mcp = yield* MCP.Service
  return (yield* mcp.status())[NAME]
})

// Generous window: the isolated test XDG cache means the first `uv tool run`
// resolves and downloads a managed Python plus falcon-mcp from PyPI.
const awaitStatus = (expected: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* statusOf()
      return status?.status === expected ? status : undefined
    }),
    `managed server ${NAME} did not reach ${expected}`,
    "5 minutes",
  )

const restoreCatalog = Effect.addFinalizer(() => Effect.sync(() => McpIntegration.sync(ExtensionCatalog.manifests)))

register("connects the pinned falcon-mcp package to the mock Falcon API", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    const mock = yield* serveFalconApi()
    api.url = mock.url
    const mcp = yield* MCP.Service

    yield* mcp.tools()
    yield* awaitStatus("connected")

    const tools = Object.keys(yield* mcp.tools())
    expect(tools).toContain(`${NAME}_falcon_search_hosts`)
    expect(tools).toContain(`${NAME}_falcon_search_detections`)
    expect(tools).toContain(`${NAME}_falcon_search_ngsiem`)
    // Upstream read-only tools outside the manifest allowlist stay hidden.
    expect(tools).not.toContain(`${NAME}_falcon_search_iocs`)
    expect(tools).not.toContain(`${NAME}_falcon_create_case`)
    expect(mock.requests).toContain("POST /oauth2/token")

    const client = (yield* mcp.clients())[NAME]
    expect(client).toBeDefined()
    const result = yield* Effect.promise(() =>
      client!.callTool({ name: "falcon_search_hosts", arguments: { filter: "hostname:'mock*'" } }, CallToolResultSchema),
    )
    expect(result.isError).not.toBe(true)
    const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
    expect(text).toContain("mock-workstation-01")
    expect(mock.requests.some((entry) => entry.includes("/devices/"))).toBe(true)
  }),
)

register("surfaces the server's auth failure message instead of a bare connection close", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    const mock = yield* serveFalconApi({ authStatus: 401 })
    api.url = mock.url
    const mcp = yield* MCP.Service

    yield* mcp.tools()
    const status = yield* awaitStatus("failed")

    expect(status.status === "failed" && status.error).toContain("Failed to authenticate")
    expect(mock.requests).toContain("POST /oauth2/token")
    const log = yield* mcp.log(NAME)
    expect(log.some((line) => line.includes("Failed to authenticate"))).toBe(true)
    // The persisted extension observation carries the failure + output tail —
    // that's what the Extensions UI surfaces (the read route has no instance
    // context, so it cannot query live MCP state).
    const observed = yield* pollWithTimeout(
      Effect.gen(function* () {
        const entry = yield* ExtensionObservation.read(FALCON_ID)
        return entry?.status === "failed" ? entry : undefined
      }),
      "extension observation did not reach failed",
    )
    expect(observed.detail).toContain("Failed to authenticate")
    expect(observed.log?.some((line) => line.includes("Failed to authenticate"))).toBe(true)
  }),
)
