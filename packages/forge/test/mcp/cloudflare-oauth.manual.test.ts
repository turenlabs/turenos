import { expect, setDefaultTimeout } from "bun:test"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Effect } from "effect"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { McpAuth } from "../../src/mcp/auth"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { testEffect } from "../lib/effect"

const enabled = process.env.TUREN_CLOUDFLARE_OAUTH_E2E === "1"
const endpoint = "https://auditlogs.mcp.cloudflare.com/mcp"
const serverName = "cloudflare-audit-e2e"

setDefaultTimeout(10 * 60 * 1000)

const harness = testEffect(
  LayerNode.compile(
    LayerNode.group([MCP.testNode, McpAuth.node, EventV2Bridge.node, Config.node, CrossSpawnSpawner.node, FSUtil.node]),
  ),
)

const register = enabled ? harness.instance : harness.instance.skip

register("connects to Cloudflare Audit Logs through the real OAuth flow", () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

    const mcp = yield* MCP.Service
    const added = yield* mcp.add(serverName, { type: "remote", url: endpoint })
    expect(added.candidate).toMatchObject({ status: "needs_auth" })

    console.log("Cloudflare OAuth harness: waiting for authorization in the browser...")
    const status = yield* mcp.authenticate(serverName, (authorizationUrl) => {
      console.log(`Cloudflare OAuth harness: authorization URL opened: ${authorizationUrl}`)
    })
    expect(status).toEqual({ status: "connected" })

    const tools = yield* mcp.tools()
    const toolKeys = Object.keys(tools).filter((key) => key.startsWith(`${serverName}_`))
    console.log(`Cloudflare OAuth harness: connected; tools=${toolKeys.join(",")}`)
    expect(toolKeys).toContain(`${serverName}_auditlogs_by_account_id`)
  }),
)
