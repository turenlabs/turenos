import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { EventV2 } from "@turenlabs/core/event"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Extension } from "@turenlabs/schema"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpAuth } from "../../src/mcp/auth"
import { McpIntegration } from "../../src/mcp/integration"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { serveOAuthMcp, stopOAuthCallback } from "./fixture/oauth-server"

// Hosted policy qualification rejects loopback endpoints, so the fixture server
// can never connect; reconcile is observed through status transitions instead.
const fixture = new Extension.Manifest({
  schemaVersion: 1,
  id: Extension.ID.make("turenlabs", "refresh-fixture"),
  name: "Refresh fixture",
  description: "Managed reconcile fixture",
  version: "1.0.0",
  publisher: "Turen Labs",
  trust: "official",
  contributions: [
    {
      type: "mcp",
      id: Extension.ContributionID.make("refresh-fixture"),
      name: "Refresh fixture",
      description: "Refresh fixture MCP",
      instructions: "Fixture instructions.",
      adapter: "mcp:refresh-fixture",
      secrets: [],
      defaultEnabled: false,
      upstreamPolicy: "static",
      deployment: { type: "hosted", url: "https://refresh-fixture.invalid/mcp" },
      authentication: "oauth",
      localOnly: true,
      tools: { allow: ["fixture_tool"], write: [] },
    },
  ],
})

let extensionEnabled = true

const it = testEffect(
  LayerNode.compile(LayerNode.group([MCP.testNode, McpAuth.node, EventV2.node, CrossSpawnSpawner.node]), [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, {
        manifests: () => Effect.succeed([...ExtensionCatalog.manifests, fixture]),
        enabled: (id) => Effect.succeed(String(id) === String(fixture.id) && extensionEnabled),
        configuration: () => Effect.succeed({}),
        secret: () => Effect.succeed(undefined),
        secretsSet: () => Effect.succeed({}),
      }),
    ],
  ]),
)

const NAME = "refresh-fixture"
const ENDPOINT = "https://refresh-fixture.invalid/mcp"

const statusOf = Effect.fnUntraced(function* (name: string) {
  const mcp = yield* MCP.Service
  return (yield* mcp.status())[name]?.status
})

const awaitStatus = (name: string, expected: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* statusOf(name)
      return status === expected ? status : undefined
    }),
    `managed server ${name} did not reach ${expected}`,
  )

const restoreCatalog = Effect.addFinalizer(() => Effect.sync(() => McpIntegration.sync(ExtensionCatalog.manifests)))

it.instance("admitted managed config carries the runtime policy marker", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    const mcp = yield* MCP.Service
    yield* mcp.tools()
    yield* awaitStatus(NAME, "failed")

    const configured = yield* mcp.configuration(NAME)
    expect(McpIntegration.managedID(configured!)).toBe(NAME)
  }),
)

it.instance("skips admission while the extension is disabled", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    extensionEnabled = false
    const mcp = yield* MCP.Service
    yield* mcp.tools()

    expect(yield* statusOf(NAME)).toBeUndefined()
    expect(yield* mcp.configuration(NAME)).toBeUndefined()
    extensionEnabled = true
  }),
)

it.instance("retries needs_auth only after OAuth tokens are committed", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service

    yield* mcp.tools()
    yield* awaitStatus(NAME, "failed")

    // A directory that observed the server before authorization completed is
    // stuck on needs_auth; the credential commit can land under a different
    // directory because McpAuth storage is process-global.
    yield* mcp.removeAuth(NAME)
    expect(yield* statusOf(NAME)).toBe("needs_auth")

    yield* mcp.tools()
    yield* mcp.tools()
    expect(yield* statusOf(NAME)).toBe("needs_auth")

    yield* auth.set(NAME, { tokens: { accessToken: "fixture-token" } }, ENDPOINT)
    yield* mcp.tools()
    yield* awaitStatus(NAME, "failed")
  }),
)

it.instance("reconnects a disconnected managed server while the extension is enabled", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    const mcp = yield* MCP.Service

    yield* mcp.tools()
    yield* awaitStatus(NAME, "failed")
    yield* mcp.disconnect(NAME)
    expect(yield* statusOf(NAME)).toBe("disabled")

    yield* mcp.tools()
    yield* awaitStatus(NAME, "failed")
  }),
)

it.instance("reconciles needs_auth independently in a second directory", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const other = yield* tmpdirScoped()

    yield* mcp.tools().pipe(provideInstance(other))
    yield* pollWithTimeout(
      statusOf(NAME)
        .pipe(provideInstance(other))
        .pipe(Effect.map((status) => (status === "failed" ? status : undefined))),
      `managed server ${NAME} did not reach failed in second directory`,
    )
    yield* mcp.removeAuth(NAME).pipe(provideInstance(other))
    expect(yield* statusOf(NAME).pipe(provideInstance(other))).toBe("needs_auth")

    yield* auth.set(NAME, { tokens: { accessToken: "fixture-token" } }, ENDPOINT)
    yield* mcp.tools().pipe(provideInstance(other))

    yield* pollWithTimeout(
      statusOf(NAME)
        .pipe(provideInstance(other))
        .pipe(Effect.map((status) => (status === "failed" ? status : undefined))),
      `managed server ${NAME} did not retry in second directory`,
    )
  }),
)

// Full path end to end: a directory parked on needs_auth picks up credentials
// committed by an OAuth flow that ran under a different directory, reconnects
// for real, and lists the managed tools.
it.instance("connects in the session directory after OAuth completes under another", () =>
  Effect.gen(function* () {
    yield* restoreCatalog
    yield* stopOAuthCallback
    const advertised = "https://refresh-fixture.invalid"
    const server = yield* serveOAuthMcp({ advertise: advertised, toolName: "fixture_tool" })
    const origin = new globalThis.URL(server.url).origin
    McpIntegration.setPolicyDependencies({
      now: Date.now,
      resolve: async () => ["93.184.216.34"],
      request: (url, init) => fetch(new globalThis.URL(url.pathname + url.search, origin), init),
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => McpIntegration.setPolicyDependencies(undefined)))

    const mcp = yield* MCP.Service
    const other = yield* tmpdirScoped()

    yield* mcp.tools()
    yield* awaitStatus(NAME, "needs_auth")

    yield* mcp.tools().pipe(provideInstance(other))
    yield* pollWithTimeout(
      statusOf(NAME)
        .pipe(provideInstance(other))
        .pipe(Effect.map((status) => (status === "needs_auth" ? status : undefined))),
      `managed server ${NAME} did not reach needs_auth in second directory`,
    )
    const started = yield* mcp.startAuth(NAME).pipe(provideInstance(other))
    expect(started.authorizationUrl).toContain(`${advertised}/authorize`)
    const finished = yield* mcp.finishAuth(NAME, "valid-code").pipe(provideInstance(other))
    expect(finished.status).toBe("connected")

    // Per-directory state: the session directory is still parked until its next
    // tools() pass reconciles.
    expect(yield* statusOf(NAME)).toBe("needs_auth")

    yield* mcp.tools()
    yield* awaitStatus(NAME, "connected")
    expect(Object.keys(yield* mcp.tools())).toEqual([`${NAME}_fixture_tool`])
  }),
)
