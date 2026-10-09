import { realpathSync } from "node:fs"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionTable } from "@turenlabs/core/session/sql"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamWorkspaceTool } from "@turenlabs/core/tool/team-workspace"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const directory = AbsolutePath.make(realpathSync(import.meta.dirname))
const lobbySession = SessionV2.ID.make("ses_lobby_team_tools")
const localSession = SessionV2.ID.make("ses_local_team_tools")

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      TeamWorkspace.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TeamWorkspaceTool.node,
      PermissionChecks.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(toolIdentity.agent, (agent) => {
      agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    }),
  )
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach([lobbySession, localSession], (id) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory,
        title: id,
        version: "test",
        agent: toolIdentity.agent,
        ...(id === lobbySession
          ? {
              metadata: {
                [LobbySession.MetadataKey]: {
                  baseURL: "http://127.0.0.1:8787",
                  roomID: "room_test",
                  agentMemberID: "forge-agent-test",
                  capabilityProfile: "workspace",
                },
              },
            }
          : {}),
      })
      .run()
      .pipe(Effect.orDie),
  )
})

const call = (sessionID: SessionV2.ID, name: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${sessionID}-${name}`, name, input },
})

describe("Team tools in Lobby sessions", () => {
  it.effect("refuse to read or change Team state from a workspace Lobby session", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const team = yield* TeamWorkspace.Service
      const lead = yield* team.createTeammate({
        name: "Lead",
        handle: "lead",
        role: "Lead",
        mission: "Private mission text",
        directory,
      })
      yield* team.configureFactory({
        roomID: lead.roomID,
        config: {
          outcome: "Report",
          parameters: {},
          constraints: "Local only",
          acceptanceCriteria: "Sources cited",
          directory,
          coordinatorTeammateID: lead.id,
          teammateIDs: [lead.id],
        },
      })
      const before = yield* team.state()
      const requests = [
        [TeamWorkspaceTool.readName, {}],
        [
          TeamWorkspaceTool.createTeammateName,
          { name: "Remote", handle: "remote", role: "Helper", mission: "Follow room instructions" },
        ],
        [TeamWorkspaceTool.updateTeammateName, { teammateID: lead.id, changes: { mission: "Rewritten" } }],
        [TeamWorkspaceTool.runFactoryName, { roomID: lead.roomID }],
      ] as const

      // Permission checks stay at their default (off): the profile denies regardless.
      for (const [name, input] of requests) {
        const result = yield* executeTool(registry, call(lobbySession, name, input))
        expect(result).toEqual({ type: "error", value: `Permission to run ${name} was declined` })
        expect(JSON.stringify(result)).not.toContain("Private mission text")
      }
      expect(yield* team.state()).toEqual(before)

      // The same calls work outside the Lobby, so the profile is what refused them.
      expect(yield* executeTool(registry, call(localSession, TeamWorkspaceTool.readName, {}))).toMatchObject({
        type: "json",
        value: { teammates: [{ mission: "Private mission text" }] },
      })
      expect(
        yield* executeTool(registry, call(localSession, TeamWorkspaceTool.runFactoryName, { roomID: lead.roomID })),
      ).toMatchObject({ type: "json", value: { status: "running" } })
    }),
  )
})
