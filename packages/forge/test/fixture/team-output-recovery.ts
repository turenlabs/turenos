import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Database } from "@turenlabs/core/database/database"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { Location } from "@turenlabs/core/location"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionMessageTable } from "@turenlabs/core/session/sql"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { TeamRuntime } from "../../src/team/runtime"

// Only placement and provider execution are replaced. Persistence, decoding and publication are real services.
export function recoveryLayer(filename = ":memory:", runtime = false) {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, SessionV2.node, TeamWorkspace.node, ...(runtime ? [TeamRuntime.node] : [])]),
    [
      [Database.node, Database.layerFromPath(filename)],
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        ProjectV2.node,
        Layer.succeed(
          ProjectV2.Service,
          ProjectV2.Service.of({
            resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
            directories: () => Effect.succeed([]),
            remember: () => Effect.void,
          }),
        ),
      ],
    ],
  )
}

export const seedRecoveryTask = (handle: string, count = 1, bytes = 64) =>
  Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const sessions = yield* SessionV2.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.global,
        worktree: AbsolutePath.make("/recovery-fixture"),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
    const mate = yield* team.createTeammate({ name: handle, handle, role: "Worker", mission: "Synthetic recovery" })
    const posted = yield* team.postMessage({ id: `msg_request_${handle}`, text: `@${handle} recover output` })
    const task = posted.tasks[0]!
    yield* team.claimTasks({ owner: handle })
    yield* team.startTask({ id: task.id, owner: handle })
    const sessionID = SessionV2.ID.make(task.sessionID)
    yield* sessions.create({
      id: sessionID,
      location: Location.Ref.make({ directory: AbsolutePath.make("/recovery-fixture") }),
    })
    const prompt = {
      id: SessionMessage.ID.make(`msg_team_${task.id}`),
      sessionID,
      prompt: { text: "Synthetic task" },
      resume: false,
    }
    yield* sessions.prompt(prompt)
    yield* sessions.prompt(prompt)
    const encode = Schema.encodeSync(SessionMessage.Message)
    const user = encode(
      SessionMessage.User.make({
        id: prompt.id,
        type: "user",
        text: prompt.prompt.text,
        time: { created: DateTime.makeUnsafe(1) },
      }),
    )
    const { id, type, ...data } = user
    // Seed projected history to model a stopped runner, without executing a provider or live output listener.
    yield* db
      .insert(SessionMessageTable)
      .values({ id: SessionMessage.ID.make(id), type, data, session_id: sessionID, seq: 1 })
      .run()
    yield* db
      .insert(SessionMessageTable)
      .values(Array.from({ length: count }, (_, index) => recoveryOutputRow(sessionID, handle, index, bytes)))
      .run()
    return { task, mate, sessionID, prompt }
  })

export function recoveryOutputRow(sessionID: SessionV2.ID, handle: string, index: number, bytes: number) {
  const encoded = Schema.encodeSync(SessionMessage.Message)(
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make(`msg_${handle}_${index}`),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("synthetic"), providerID: ProviderV2.ID.make("synthetic") },
      finish: "stop",
      content: [
        {
          id: `tool_${index}`,
          type: "tool",
          name: "bash",
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "x".repeat(bytes) }],
            structured: {},
          },
          time: { created: DateTime.makeUnsafe(2) },
        },
        { id: `text_${index}`, type: "text", text: `Recovered ${handle} ${index}` },
      ],
      time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
    }),
  )
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), type, data, session_id: sessionID, seq: index + 2 }
}
