export * as WhiteboardTool from "./whiteboard"

import { randomInt, randomUUID } from "node:crypto"
import { ToolFailure } from "@turenlabs/llm"
import { Element } from "@turenlabs/schema/whiteboard"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { Whiteboard } from "../session/whiteboard"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const readName = "whiteboard_read"
export const updateName = "whiteboard_update"
const Identity = Schema.NonEmptyString.check(Schema.isMaxLength(128))
const Coordinate = Schema.Number.check(Schema.isBetween({ minimum: -1e9, maximum: 1e9 }))
const Dimension = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1e9 }))
const Kind = Schema.Literals(["rectangle", "ellipse", "diamond", "line", "arrow", "text"])
const Color = Schema.String.check(Schema.isPattern(/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32})$/))
const Arrowhead = Schema.NullOr(Schema.Literals(["arrow", "bar", "dot", "triangle", "circle", "circle_outline"]))
export const Operation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("upsert"),
    id: Schema.optional(Identity),
    type: Schema.optional(Kind),
    x: Schema.optional(Coordinate),
    y: Schema.optional(Coordinate),
    width: Schema.optional(Dimension),
    height: Schema.optional(Dimension),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(10000))),
    strokeColor: Schema.optional(Color),
    backgroundColor: Schema.optional(Color),
    fontSize: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
    points: Schema.optional(
      Schema.Array(Schema.Tuple([Coordinate, Coordinate])).check(Schema.isMinLength(2), Schema.isMaxLength(1000)),
    ),
    startArrowhead: Schema.optional(Arrowhead),
    endArrowhead: Schema.optional(Arrowhead),
  }),
  Schema.Struct({ op: Schema.Literal("remove"), id: Identity }),
])
export const Operations = Schema.Array(Operation).check(Schema.isMinLength(1), Schema.isMaxLength(1000))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Construct standalone Excalidraw elements without loading its browser runtime. */
export function normalize(elements: ReadonlyArray<Element>, operations: typeof Operations.Type): Element[] {
  const decoded = Schema.decodeUnknownSync(Operations)(operations)
  const current = new Map(elements.map((element) => [String(element.id), element]))
  const changed = new Map<string, Element>()
  decoded.forEach((operation) => {
    const id = operation.id ?? randomUUID()
    const previous = current.get(id)
    const version = typeof previous?.version === "number" ? previous.version + 1 : 1
    const versionNonce =
      (randomInt(0, 2147483646) + (typeof previous?.versionNonce === "number" ? previous.versionNonce + 1 : 0)) %
      2147483647
    const updated = Date.now()
    if (operation.op === "remove") {
      if (!previous) throw new Error(`Element ${id} not found; read the board before removing it`)
      const element = { ...previous, isDeleted: true, version, versionNonce, updated }
      current.set(id, element)
      changed.set(id, element)
      return
    }
    const type = operation.type ?? previous?.type
    if (!Schema.is(Kind)(type))
      throw new Error("New elements require a supported type; images, links and embeds cannot be edited by this tool")
    if (previous && previous.type !== type)
      throw new Error(`Cannot change element ${id}'s type; remove it and create a new element`)
    if (!previous && (operation.x === undefined || operation.y === undefined))
      throw new Error("New elements require x and y")
    if (operation.text !== undefined && type !== "text") throw new Error("Text must be a standalone text element")
    if (operation.fontSize !== undefined && type !== "text") throw new Error("fontSize is only supported on text")
    const linear = type === "line" || type === "arrow"
    if (
      !linear &&
      (operation.points !== undefined || operation.startArrowhead !== undefined || operation.endArrowhead !== undefined)
    )
      throw new Error("Points and arrowheads require a line or arrow")
    const element: Record<string, Element[string]> = previous
      ? { ...previous }
      : {
          id,
          type,
          x: operation.x!,
          y: operation.y!,
          width: 160,
          height: 100,
          angle: 0,
          strokeColor: "#1b1b1f",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 2,
          strokeStyle: "solid",
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          boundElements: null,
          seed: randomInt(0, 2147483647),
          link: null,
          locked: false,
          isDeleted: false,
          version,
          versionNonce,
          updated,
        }
    Object.entries(operation).forEach(([key, value]) => {
      if (key !== "op" && key !== "id" && value !== undefined) element[key] = value
    })
    if (type === "text") {
      if (!previous) {
        const text = operation.text ?? ""
        const fontSize = operation.fontSize ?? 20
        Object.assign(element, {
          text,
          originalText: text,
          fontSize,
          fontFamily: 5,
          lineHeight: 1.25,
          autoResize: true,
          containerId: null,
          textAlign: "left",
          verticalAlign: "top",
        })
      }
      if (operation.text !== undefined) element.originalText = operation.text
      if (!previous || operation.text !== undefined || operation.fontSize !== undefined) {
        // Core has no font renderer: retain useful estimated bounds after every text edit.
        const fontSize = Number(element.fontSize)
        const widths = String(element.text)
          .split("\n")
          .map((line) => line.length * fontSize * 0.6)
        element.width =
          operation.width ?? (previous?.autoResize === false ? Number(previous.width) : Math.max(1, ...widths))
        const lines =
          previous?.autoResize === false
            ? widths.reduce(
                (total, width) => total + Math.max(1, Math.ceil(width / Math.max(1, Number(element.width)))),
                0,
              )
            : widths.length
        element.height = operation.height ?? lines * fontSize * Number(element.lineHeight ?? 1.25)
      }
    }
    if (linear) {
      if (!previous)
        Object.assign(element, {
          points: operation.points ?? [
            [0, 0],
            [operation.width ?? 160, operation.height ?? 0],
          ],
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: type === "arrow" ? "arrow" : null,
          lastCommittedPoint: null,
          elbowed: false,
        })
      if (operation.startArrowhead !== undefined) element.startArrowhead = operation.startArrowhead
      if (operation.endArrowhead !== undefined) element.endArrowhead = operation.endArrowhead
      const points = Schema.decodeUnknownSync(
        Schema.Array(Schema.Tuple([Coordinate, Coordinate])).check(Schema.isMinLength(2), Schema.isMaxLength(1000)),
      )(element.points)
      if (operation.points && (points[0]![0] !== 0 || points[0]![1] !== 0))
        throw new Error("Local points must begin at [0,0]")
      const xs = points.map((point) => point[0])
      const ys = points.map((point) => point[1])
      const width = Math.max(...xs) - Math.min(...xs)
      const height = Math.max(...ys) - Math.min(...ys)
      if (
        previous &&
        operation.points === undefined &&
        (operation.width !== undefined || operation.height !== undefined)
      ) {
        if ((!width && operation.width) || (!height && operation.height))
          throw new Error("Supply points to resize a zero-width or zero-height line")
        element.points = points.map((point) => [
          point[0] * (operation.width === undefined || !width ? 1 : operation.width / width),
          point[1] * (operation.height === undefined || !height ? 1 : operation.height / height),
        ])
      }
      element.width = previous && operation.points === undefined ? (operation.width ?? width) : width
      element.height = previous && operation.points === undefined ? (operation.height ?? height) : height
    }
    ;["x", "y", "width", "height"].forEach((key) => {
      if (typeof element[key] !== "number" || !Number.isFinite(element[key]) || Math.abs(element[key]) > 1e9)
        throw new Error(`Invalid or excessive ${key}`)
    })
    Object.assign(element, { version, versionNonce, updated })
    current.set(id, element)
    changed.set(id, element)
  })
  return Array.from(changed.values())
}

const summary = (element: Element): Element =>
  Object.fromEntries(
    Object.entries(element)
      .filter(([key]) => ["id", "type", "x", "y", "width", "height", "text", "isDeleted"].includes(key))
      .map(([key, value]) => [key, key === "text" && typeof value === "string" ? value.slice(0, 1000) : value]),
  )
const failure = (error: unknown) =>
  new ToolFailure({ message: error instanceof Error ? error.message : "Whiteboard operation failed" })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const board = yield* Whiteboard.Service
    const sessions = yield* SessionStore.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const target = (explicit: SessionSchema.ID | undefined, context: Tool.Context, action: string) =>
      Effect.gen(function* () {
        const active = yield* sessions.get(context.sessionID)
        if (!active) return yield* new ToolFailure({ message: "Current session not found" })
        if (active.location.directory !== location.directory || active.location.workspaceID !== location.workspaceID)
          return yield* new ToolFailure({ message: "Current session belongs to another Location" })
        const root = { session: active }
        const seen = new Set<string>()
        while (!explicit && root.session.parentID) {
          if (seen.has(root.session.id)) return yield* new ToolFailure({ message: "Session ancestry contains a cycle" })
          seen.add(root.session.id)
          const parent = yield* sessions.get(root.session.parentID)
          if (!parent) return yield* new ToolFailure({ message: "Parent session not found" })
          root.session = parent
        }
        const sessionID = explicit ?? root.session.id
        yield* permission
          .assert({
            action,
            resources: [sessionID],
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          .pipe(Effect.mapError(failure))
        return sessionID
      })
    yield* tools
      .register({
        [readName]: Tool.make({
          description:
            "Read the human-visible root session whiteboard before drawing. Returns revision for compare-and-swap updates, compact element bounds/text and file metadata (never image bytes). Supply elementIds to select up to 1000 elements; otherwise returns the first 1000 including tombstones. Explicit sessionID targets another session subject to permission.",
          input: Schema.Struct({
            sessionID: Schema.optional(SessionSchema.ID),
            elementIds: Schema.optional(Schema.Array(Identity).check(Schema.isMaxLength(1000))),
          }),
          output: Schema.Struct({
            sessionID: SessionSchema.ID,
            revision: Revision,
            elements: Schema.Array(Element),
            files: Schema.Array(Schema.Struct({ id: Schema.String, mimeType: Schema.String, created: Schema.Number })),
            total: Schema.Int,
            truncated: Schema.Boolean,
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const sessionID = yield* target(input.sessionID, context, readName)
              const snapshot = yield* board.get(sessionID).pipe(Effect.mapError(failure))
              const ids = input.elementIds === undefined ? undefined : new Set(input.elementIds)
              const selected = snapshot.elements.filter((element) => !ids || ids.has(String(element.id)))
              return {
                sessionID,
                revision: snapshot.revision,
                elements: selected.slice(0, 1000).map((element) => ({
                  ...summary(element),
                  ...Object.fromEntries(
                    Object.entries(element).filter(([key]) =>
                      [
                        "angle",
                        "strokeColor",
                        "backgroundColor",
                        "fontSize",
                        "points",
                        "startArrowhead",
                        "endArrowhead",
                        "version",
                      ].includes(key),
                    ),
                  ),
                })),
                files: Object.values(snapshot.files).map((file) => ({
                  id: file.id,
                  mimeType: file.mimeType,
                  created: file.created,
                })),
                total: selected.length,
                truncated: selected.length > 1000,
              }
            }),
        }),
        [updateName]: Tool.make({
          description:
            "Draw on the human-visible root session whiteboard. Read first and supply its baseRevision; concurrent changes fail, so read and retry. Operations use op: upsert or remove. New upserts require type,x,y (id optional); existing ids accept partial patches, including text alone. Text is standalone; use separate shapes and text labels. For line/arrow points use local [x,y] coordinates beginning at [0,0]; points determine bounds. No images, links or embeds. Removed elements remain tombstones. Explicit sessionID is permission checked.",
          input: Schema.Struct({
            sessionID: Schema.optional(SessionSchema.ID),
            baseRevision: Revision,
            operations: Operations,
          }),
          output: Schema.Struct({ sessionID: SessionSchema.ID, revision: Revision, elements: Schema.Array(Element) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const sessionID = yield* target(input.sessionID, context, updateName)
              const snapshot = yield* board.get(sessionID).pipe(Effect.mapError(failure))
              if (snapshot.revision !== input.baseRevision)
                return yield* new ToolFailure({
                  message: `Whiteboard revision changed from ${input.baseRevision} to ${snapshot.revision}; read and retry`,
                })
              const elements = yield* Effect.try({
                try: () => normalize(snapshot.elements, input.operations),
                catch: failure,
              })
              const next = yield* board
                .update(
                  sessionID,
                  { baseRevision: input.baseRevision, elements },
                  { id: context.agent, name: context.agent, kind: "agent" },
                )
                .pipe(Effect.mapError(failure))
              const last = elements.at(-1)
              const pointer =
                last && last.isDeleted !== true
                  ? { x: Number(last.x) + Number(last.width) / 2, y: Number(last.y) + Number(last.height) / 2 }
                  : undefined
              // Presence is advisory: its failure must not invalidate the already committed edit.
              yield* board
                .presence(sessionID, {
                  clientID: `agent:${context.sessionID}`.slice(0, 128),
                  username: `${context.agent.slice(0, 120)} (agent)`,
                  selectedElementIds: elements.map((element) => String(element.id)),
                  ...(pointer && Math.abs(pointer.x) <= 1e9 && Math.abs(pointer.y) <= 1e9 ? { pointer } : {}),
                })
                .pipe(Effect.catchCause(() => Effect.void))
              return { sessionID, revision: next.revision, elements: elements.map(summary) }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/whiteboard",
  layer,
  deps: [ToolRegistry.node, Whiteboard.node, SessionStore.node, PermissionV2.node, Location.node],
})
