import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { FileMutation } from "@turenlabs/core/file-mutation"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { ApplyPatchTool } from "@turenlabs/core/tool/apply-patch"
import { EditTool } from "@turenlabs/core/tool/edit"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { WriteTool } from "@turenlabs/core/tool/write"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { executeTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_subagent_authority_tools")
const it = testEffect(Layer.empty)

const withTools = <A, E, R>(
  directory: string,
  writeRoot: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) => {
  const current = Location.Service.of(location({ directory: AbsolutePath.make(directory) }))
  const session = SessionSchema.Info.make({
    id: sessionID,
    projectID: ProjectV2.ID.global,
    agent: AgentV2.ID.make("build"),
    title: "Subagent authority test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make(directory) },
  })
  const authority = SessionTaskV2.Authority.make({
    parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
    ancestorPermissionSets: [],
    childPermissions: [{ action: "*", resource: "*", effect: "allow" }],
    hardPermissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "allowed", effect: "allow" },
      { action: "edit", resource: "allowed/*", effect: "allow" },
    ],
    writeRoots: [AbsolutePath.make(writeRoot)],
    commands: [],
  })
  const saved = [
    {
      id: PermissionSaved.ID.create(),
      projectID: ProjectV2.ID.global,
      action: "edit",
      resource: "*",
    },
    {
      id: PermissionSaved.ID.create(),
      projectID: ProjectV2.ID.global,
      action: "external_directory",
      resource: "*",
    },
  ]
  return Effect.gen(function* () {
    yield* (yield* AgentV2.Service).transform((editor) =>
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }),
    )
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          AgentV2.node,
          PermissionV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          WriteTool.node,
          EditTool.node,
          ApplyPatchTool.node,
        ]),
        [
          [Location.node, Layer.succeed(Location.Service, current)],
          [EventV2.node, Layer.mock(EventV2.Service, {})],
          [
            PermissionChecks.node,
            Layer.mock(PermissionChecks.Service, {
              enforced: () => Effect.succeed(false),
              set: () => Effect.void,
              untilDisabled: () => Effect.never,
            }),
          ],
          [
            PermissionSaved.node,
            Layer.mock(PermissionSaved.Service, {
              add: () => Effect.void,
              list: () => Effect.succeed(saved),
              remove: () => Effect.void,
            }),
          ],
          [SessionStore.node, Layer.mock(SessionStore.Service, { get: () => Effect.succeed(session) })],
          [
            SessionTaskV2.node,
            Layer.mock(SessionTaskV2.Service, {
              authority: (id) => Effect.succeed(id === sessionID ? authority : undefined),
            }),
          ],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (name: string, id: string, input: unknown): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call", id, name, input },
})

describe("task mutation authority", () => {
  it.live("contains real write, edit, patch update, and patch delete operations to canonical write roots", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([workspace, outside]) =>
        Effect.gen(function* () {
          const allowed = path.join(workspace.path, "allowed")
          const outsideTarget = path.join(outside.path, "sentinel.txt")
          yield* Effect.promise(() =>
            Promise.all([fs.mkdir(allowed), fs.writeFile(outsideTarget, "outside sentinel\n")]),
          )
          const canonicalRoot = yield* Effect.promise(() => fs.realpath(allowed))

          yield* withTools(workspace.path, canonicalRoot, (registry) =>
            Effect.gen(function* () {
              expect(
                yield* executeTool(
                  registry,
                  call("write", "call-outside-write", { path: outsideTarget, content: "overwritten" }),
                ),
              ).toMatchObject({ type: "error" })
              expect(yield* Effect.promise(() => fs.readFile(outsideTarget, "utf8"))).toBe("outside sentinel\n")

              expect(
                yield* executeTool(
                  registry,
                  call("edit", "call-outside-edit", {
                    path: outsideTarget,
                    oldString: "outside sentinel",
                    newString: "overwritten",
                  }),
                ),
              ).toMatchObject({ type: "error" })
              expect(yield* Effect.promise(() => fs.readFile(outsideTarget, "utf8"))).toBe("outside sentinel\n")

              expect(
                yield* executeTool(
                  registry,
                  call("apply_patch", "call-outside-update", {
                    patchText: `*** Begin Patch\n*** Update File: ${outsideTarget}\n@@\n-outside sentinel\n+overwritten\n*** End Patch`,
                  }),
                ),
              ).toMatchObject({ type: "error" })
              expect(yield* Effect.promise(() => fs.readFile(outsideTarget, "utf8"))).toBe("outside sentinel\n")

              expect(
                yield* executeTool(
                  registry,
                  call("apply_patch", "call-outside-delete", {
                    patchText: `*** Begin Patch\n*** Delete File: ${outsideTarget}\n*** End Patch`,
                  }),
                ),
              ).toMatchObject({ type: "error" })
              expect(yield* Effect.promise(() => fs.readFile(outsideTarget, "utf8"))).toBe("outside sentinel\n")

              expect(
                yield* executeTool(
                  registry,
                  call("write", "call-inside-write", { path: "allowed/inside.txt", content: "inside\n" }),
                ),
              ).toEqual({ type: "text", value: "Created file successfully: allowed/inside.txt" })
              expect(yield* Effect.promise(() => fs.readFile(path.join(allowed, "inside.txt"), "utf8"))).toBe(
                "inside\n",
              )
              expect(
                yield* executeTool(
                  registry,
                  call("edit", "call-inside-edit", {
                    path: "allowed/inside.txt",
                    oldString: "inside",
                    newString: "edited",
                  }),
                ),
              ).toMatchObject({ type: "text" })
              expect(yield* Effect.promise(() => fs.readFile(path.join(allowed, "inside.txt"), "utf8"))).toBe(
                "edited\n",
              )
              expect(
                yield* executeTool(
                  registry,
                  call("apply_patch", "call-inside-patch", {
                    patchText:
                      "*** Begin Patch\n*** Update File: allowed/inside.txt\n@@\n-edited\n+updated\n*** End Patch",
                  }),
                ),
              ).toMatchObject({ type: "text" })
              expect(yield* Effect.promise(() => fs.readFile(path.join(allowed, "inside.txt"), "utf8"))).toBe(
                "updated\n",
              )
            }),
          )
        }),
      ([workspace, outside]) =>
        Effect.promise(() =>
          Promise.all([workspace[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})
