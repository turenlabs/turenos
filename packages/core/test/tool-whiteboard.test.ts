import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTable } from "@turenlabs/core/session/sql"
import { Whiteboard } from "@turenlabs/core/session/whiteboard"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { WhiteboardTool } from "@turenlabs/core/tool/whiteboard"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Element, Updated } from "@turenlabs/schema/whiteboard"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const rectangle = { op: "upsert", id: "box", type: "rectangle", x: 10, y: 20 } as const

describe("WhiteboardTool normalization", () => {
  test("constructs renderable standalone shapes, text and arrows", () => {
    const elements = WhiteboardTool.normalize(
      [],
      [
        rectangle,
        { op: "upsert", type: "text", x: 10, y: 30, text: "Hello\nworld" },
        {
          op: "upsert",
          type: "arrow",
          x: 20,
          y: 40,
          points: [
            [0, 0],
            [-100, 50],
          ],
          endArrowhead: null,
        },
      ],
    )
    expect(elements[0]).toMatchObject({
      id: "box",
      width: 160,
      height: 100,
      version: 1,
      isDeleted: false,
      groupIds: [],
      link: null,
    })
    expect(elements[1]).toMatchObject({
      type: "text",
      text: "Hello\nworld",
      originalText: "Hello\nworld",
      fontFamily: 5,
      fontSize: 20,
      lineHeight: 1.25,
      height: 50,
      autoResize: true,
      containerId: null,
      textAlign: "left",
      verticalAlign: "top",
    })
    expect(elements[2]).toMatchObject({
      type: "arrow",
      width: 100,
      height: 50,
      startBinding: null,
      endBinding: null,
      endArrowhead: null,
      elbowed: false,
      lastCommittedPoint: null,
    })
    expect(elements[1]!.id).not.toBe(elements[2]!.id)
  })

  test("partial edits preserve human fields, do not mutate input, and version tombstones", () => {
    const original: Element = {
      ...WhiteboardTool.normalize([], [{ op: "upsert", id: "label", type: "text", x: 0, y: 0, text: "Before" }])[0]!,
      groupIds: ["human-group"],
      locked: true,
      customData: { author: "human" },
    }
    const updated = WhiteboardTool.normalize(
      [original],
      [{ op: "upsert", id: "label", text: "A meaningfully longer label" }],
    )[0]!
    expect(updated).toMatchObject({
      x: 0,
      y: 0,
      text: "A meaningfully longer label",
      originalText: "A meaningfully longer label",
      groupIds: ["human-group"],
      locked: true,
      customData: { author: "human" },
      version: 2,
    })
    expect(updated.versionNonce).not.toBe(original.versionNonce)
    expect(original.text).toBe("Before")
    expect(Number(updated.width)).toBeGreaterThan(Number(original.width))
    const removed = WhiteboardTool.normalize([updated], [{ op: "remove", id: "label" }])[0]!
    expect(removed).toMatchObject({
      text: "A meaningfully longer label",
      groupIds: ["human-group"],
      version: 3,
      isDeleted: true,
    })
    expect(updated.isDeleted).toBe(false)
  })

  test("text size edits resize estimates while preserving manual width and explicit dimensions", () => {
    const original: Element = {
      ...WhiteboardTool.normalize([], [{ op: "upsert", id: "label", type: "text", x: 15, y: 25, text: "Label" }])[0]!,
      frameId: "frame",
      strokeColor: "red",
    }
    const larger = WhiteboardTool.normalize([original], [{ op: "upsert", id: "label", fontSize: 40 }])[0]!
    expect(larger).toMatchObject({
      id: "label",
      x: 15,
      y: 25,
      frameId: "frame",
      strokeColor: "red",
      width: Number(original.width) * 2,
      height: Number(original.height) * 2,
    })
    const wrapped = WhiteboardTool.normalize(
      [{ ...original, autoResize: false }],
      [{ op: "upsert", id: "label", text: "A meaningfully longer label" }],
    )[0]!
    expect(wrapped.width).toBe(original.width)
    expect(Number(wrapped.height)).toBeGreaterThan(Number(original.height))
    const explicit = WhiteboardTool.normalize(
      [original],
      [{ op: "upsert", id: "label", fontSize: 40, width: 333, height: 77 }],
    )[0]!
    expect(explicit).toMatchObject({ width: 333, height: 77 })
  })

  test("validates primitive geometry and batches before constructing any changes", () => {
    expect(() => WhiteboardTool.normalize([], [{ op: "upsert", type: "text", text: "Missing position" }])).toThrow(
      "x and y",
    )
    expect(() => WhiteboardTool.normalize([], [{ ...rectangle, x: Infinity }])).toThrow()
    expect(() => WhiteboardTool.normalize([], [{ ...rectangle, width: -1 }])).toThrow()
    expect(() =>
      WhiteboardTool.normalize(
        [],
        [
          {
            op: "upsert",
            type: "arrow",
            x: 0,
            y: 0,
            points: [
              [1, 0],
              [10, 0],
            ],
          },
        ],
      ),
    ).toThrow("[0,0]")
    expect(() =>
      WhiteboardTool.normalize(
        [],
        Array.from({ length: 1001 }, () => rectangle),
      ),
    ).toThrow()
    expect(() => WhiteboardTool.normalize([], [{ op: "remove", id: "missing" }])).toThrow("not found")
    expect(() => WhiteboardTool.normalize([], [{ ...rectangle, text: "Label" }])).toThrow("standalone")
  })

  test("multiple operations compose by id and line resize respects point bounds", () => {
    const line = WhiteboardTool.normalize(
      [],
      [
        {
          op: "upsert",
          id: "line",
          type: "line",
          x: 0,
          y: 0,
          points: [
            [0, 0],
            [-50, 20],
          ],
        },
      ],
    )
    const result = WhiteboardTool.normalize(line, [
      { op: "upsert", id: "line", width: 100 },
      { op: "upsert", id: "line", strokeColor: "red" },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      version: 3,
      points: [
        [0, 0],
        [-100, 20],
      ],
      width: 100,
      height: 20,
      strokeColor: "red",
    })
    expect(() => WhiteboardTool.normalize(line, [{ op: "upsert", id: "line", type: "rectangle" }])).toThrow("type")
  })
})

const rootID = SessionSchema.ID.make("ses_whiteboard_root")
const childID = SessionSchema.ID.make("ses_whiteboard_child")
const otherID = SessionSchema.ID.make("ses_whiteboard_other")
const directory = AbsolutePath.make("/project")
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      AgentV2.node,
      PermissionV2.node,
      PermissionChecks.node,
      Whiteboard.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      WhiteboardTool.node,
    ]),
    [
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)
const setRules = (rules: PermissionV2.Ruleset) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(toolIdentity.agent, (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
const setup = Effect.gen(function* () {
  const checks = yield* PermissionChecks.Service
  yield* checks.set(true)
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values([
      {
        id: rootID,
        project_id: Project.ID.global,
        slug: "root",
        directory,
        title: "Root",
        version: "test",
        agent: toolIdentity.agent,
      },
      {
        id: childID,
        parent_id: rootID,
        project_id: Project.ID.global,
        slug: "child",
        directory,
        title: "Child",
        version: "test",
        agent: toolIdentity.agent,
      },
      {
        id: otherID,
        project_id: Project.ID.global,
        slug: "other",
        directory,
        title: "Other",
        version: "test",
        agent: toolIdentity.agent,
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* setRules([{ action: "whiteboard_*", resource: rootID, effect: "allow" }])
})
const call = (name: string, input: unknown, id: string, sessionID = childID) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

describe("WhiteboardTool registered execution", () => {
  it.effect("registers typed primitives and persists root-session updates with CAS", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const board = yield* Whiteboard.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name).toSorted()).toEqual([
        WhiteboardTool.readName,
        WhiteboardTool.updateName,
      ])
      expect(yield* executeTool(registry, call(WhiteboardTool.readName, {}, "read"))).toMatchObject({
        type: "json",
        value: { sessionID: rootID, revision: 0, elements: [], files: [] },
      })
      expect(
        yield* executeTool(
          registry,
          call(WhiteboardTool.updateName, { baseRevision: 0, operations: [rectangle] }, "draw"),
        ),
      ).toMatchObject({
        type: "json",
        value: { sessionID: rootID, revision: 1, elements: [{ id: "box", type: "rectangle" }] },
      })
      expect((yield* board.get(childID)).revision).toBe(0)
      expect((yield* board.get(rootID)).elements).toHaveLength(1)
      expect(
        yield* executeTool(
          registry,
          call(WhiteboardTool.updateName, { baseRevision: 0, operations: [{ op: "remove", id: "box" }] }, "stale"),
        ),
      ).toMatchObject({ type: "error", value: expect.stringContaining("revision changed") })
      expect((yield* board.get(rootID)).elements[0]!.isDeleted).toBe(false)
      expect(
        yield* executeTool(registry, call(WhiteboardTool.readName, { elementIds: ["absent"] }, "selected")),
      ).toMatchObject({ type: "json", value: { revision: 1, elements: [] } })
    }),
  )

  it.effect("asks for the exact target before mutation and preserves trusted agent provenance", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setRules([{ action: "whiteboard_update", resource: rootID, effect: "ask" }])
      const registry = yield* ToolRegistry.Service
      const permission = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const board = yield* Whiteboard.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const actor = yield* Deferred.make<Whiteboard.Actor>()
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === PermissionV2.Event.Asked.type)
          return Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        if (event.type === Updated.type)
          return Deferred.succeed(actor, Schema.decodeUnknownSync(Updated)(event).data.actor).pipe(Effect.asVoid)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* executeTool(
        registry,
        call(WhiteboardTool.updateName, { baseRevision: 0, operations: [rectangle] }, "ask-draw"),
      ).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request).toMatchObject({ action: "whiteboard_update", sessionID: childID, resources: [rootID] })
      expect((yield* board.get(rootID)).revision).toBe(0)
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(fiber)).toMatchObject({ type: "json", value: { revision: 1 } })
      expect(yield* Deferred.await(actor)).toEqual({ id: toolIdentity.agent, name: toolIdentity.agent, kind: "agent" })
      expect(yield* board.participants(rootID)).toMatchObject({
        participants: [
          {
            clientID: `agent:${childID}`,
            username: `${toolIdentity.agent} (agent)`,
            selectedElementIds: ["box"],
            pointer: { x: 90, y: 70 },
          },
        ],
      })
    }),
  )

  it.effect("denies explicit targets and missing caller sessions without mutation", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setRules([
        { action: "whiteboard_*", resource: "*", effect: "deny" },
        { action: "whiteboard_*", resource: rootID, effect: "allow" },
      ])
      const registry = yield* ToolRegistry.Service
      const board = yield* Whiteboard.Service
      expect(
        yield* executeTool(
          registry,
          call(WhiteboardTool.updateName, { sessionID: otherID, baseRevision: 0, operations: [rectangle] }, "denied"),
        ),
      ).toMatchObject({ type: "error" })
      expect((yield* board.get(otherID)).revision).toBe(0)
      expect(
        yield* executeTool(
          registry,
          call(WhiteboardTool.readName, {}, "missing", SessionSchema.ID.make("ses_missing")),
        ),
      ).toMatchObject({ type: "error", value: expect.stringContaining("Current session not found") })
    }),
  )

  it.effect("returns file metadata without image bytes", () =>
    Effect.gen(function* () {
      yield* setup
      const board = yield* Whiteboard.Service
      const registry = yield* ToolRegistry.Service
      yield* board.update(
        rootID,
        {
          elements: [],
          files: {
            image: { id: "image", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=", created: 1 },
          },
        },
        { id: "human", name: "Human", kind: "human" },
      )
      const result = yield* executeTool(registry, call(WhiteboardTool.readName, {}, "files"))
      expect(result).toMatchObject({
        type: "json",
        value: { files: [{ id: "image", mimeType: "image/png", created: 1 }] },
      })
      expect(JSON.stringify(result)).not.toContain("base64")
    }),
  )
})
