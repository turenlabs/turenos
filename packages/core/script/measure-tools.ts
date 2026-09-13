import { Effect } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { ApplicationTools } from "../src/tool/application-tools"
import { SessionToolSnapshot } from "../src/tool/session-snapshot"

const directory = AbsolutePath.make(process.argv[2] ?? process.cwd())
const agentID = AgentV2.ID.make(process.argv[3] ?? "build")
const out = process.argv[4] ?? "/tmp/forge-tools.json"

const program = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  const agent = yield* agents.get(agentID)
  const snapshots = yield* SessionToolSnapshot.Service
  const result = yield* snapshots.materialize({
    sessionID: SessionSchema.ID.make("ses_measure_tools"),
    directory,
    model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("anthropic"), id: ModelV2.ID.make("claude-sonnet-4-5") }),
    agent: agentID,
    permissions: agent?.permissions,
  })
  const defs = result.materialization.definitions.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.inputSchema,
  }))
  yield* Effect.promise(() =>
    Bun.write(out, JSON.stringify({ defs, exclusions: result.snapshot.exclusions, broker: result.snapshot.broker }, null, 2)),
  )
  console.log(`wrote ${defs.length} definitions to ${out}`)
}).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory }))))

await program.pipe(
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
  ),
  Effect.scoped,
  Effect.runPromise,
)
