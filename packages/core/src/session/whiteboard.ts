export * as Whiteboard from "./whiteboard"

import { isDeepStrictEqual } from "node:util"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { SessionID } from "@turenlabs/schema/session-id"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionStore } from "./store"
import { SessionWhiteboardTable } from "./whiteboard.sql"

export type Failure = Whiteboard.NotFoundError | Whiteboard.ValidationError | Whiteboard.ConflictError
export type Snapshot = Whiteboard.Snapshot
export type Patch = Whiteboard.Patch
export type Actor = Whiteboard.Actor
export const Limits = {
  elements: 5000,
  sceneBytes: 4 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  filesBytes: 16 * 1024 * 1024,
  participants: 64,
  presenceTTL: 30_000,
} as const
const types = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "text", "freedraw", "image", "frame"])
function invalid(message: string): never {
  throw new Whiteboard.ValidationError({ message })
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
const identity = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128

function json(value: unknown, depth = 0): void {
  if (depth > 32) invalid("JSON nesting exceeds 32 levels")
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((item) => json(item, depth + 1))
    return
  }
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    Object.entries(value).forEach(([key, item]) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) invalid("Unsafe JSON property")
      json(item, depth + 1)
    })
    return
  }
  invalid("Expected finite JSON data")
}

function element(value: Whiteboard.Element) {
  if (!identity(value.id) || typeof value.type !== "string" || !types.has(value.type))
    invalid("Element needs a bounded id and supported drawable type")
  if (
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !Number.isSafeInteger(value.versionNonce) ||
    Number(value.versionNonce) < 0
  )
    invalid(`Invalid version/versionNonce for ${value.id}`)
  if (typeof value.isDeleted !== "boolean") invalid(`Element ${value.id} needs isDeleted`)
  ;["x", "y", "width", "height", "angle"].forEach((key) => {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || Math.abs(Number(value[key])) > 1e9)
      invalid(`Invalid ${key} for ${value.id}`)
  })
  if (Number(value.width) < 0 || Number(value.height) < 0) invalid("Element dimensions must be nonnegative")
  if (value.link !== undefined && value.link !== null) invalid("Element links are disabled")
  if (["line", "arrow", "freedraw"].includes(String(value.type))) {
    if (
      !Array.isArray(value.points) ||
      value.points.length > 10000 ||
      !value.points.every(
        (point) =>
          Array.isArray(point) &&
          point.length === 2 &&
          point.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e9),
      )
    )
      invalid("Invalid drawable points")
  }
  if (
    value.type === "text" &&
    (typeof value.text !== "string" ||
      typeof value.fontSize !== "number" ||
      value.fontSize <= 0 ||
      value.fontSize > 10000)
  )
    invalid("Invalid text or fontSize")
}

function files(values: Whiteboard.Snapshot["files"]) {
  if (Object.keys(values).length > 5000 || size(values) > Limits.filesBytes)
    invalid("Files exceed cumulative 16 MiB / 5000-file limit")
  Object.entries(values).forEach(([key, file]) => {
    if (!identity(key) || file.id !== key) invalid("File id must match its map key")
    if (!Number.isFinite(file.created) || (file.lastRetrieved !== undefined && !Number.isFinite(file.lastRetrieved)))
      invalid("Invalid file timestamps")
    if (typeof file.dataURL !== "string" || file.dataURL.length > Limits.fileBytes)
      invalid("Individual image exceeds 4 MiB")
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.dataURL)
    if (!match || match[1] !== file.mimeType || match[2]!.length % 4 !== 0)
      invalid("Only base64 PNG/JPEG/WebP/GIF images are supported")
    const bytes = Buffer.from(match[2]!, "base64")
    const valid =
      file.mimeType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : file.mimeType === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : file.mimeType === "image/gif"
            ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())
            : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
    if (!valid || bytes.toString("base64") !== match[2])
      invalid("Image data does not match its MIME type or canonical base64 encoding")
  })
}

/** Pure element-level reconciliation: omission never deletes; version ties use the lower nonce. */
export function merge(current: Snapshot, patch: Patch, now = Date.now()): Snapshot {
  json(patch)
  if (!Schema.is(Whiteboard.Patch)(patch)) invalid("Invalid whiteboard patch")
  if (patch.elements.length > Limits.elements || size(patch) > Limits.sceneBytes)
    invalid("Patch exceeds 5000 elements or 4 MiB")
  if (patch.baseRevision !== undefined && patch.baseRevision !== current.revision)
    throw new Whiteboard.ConflictError({
      sessionID: current.sessionID,
      expectedRevision: patch.baseRevision,
      actualRevision: current.revision,
      message: "Whiteboard revision changed; read and retry",
    })
  const merged = new Map(current.elements.map((item) => [String(item.id), item]))
  patch.elements.forEach((item) => {
    element(item)
    const previous = merged.get(String(item.id))
    if (previous && previous.version === item.version && previous.versionNonce === item.versionNonce) {
      if (!isDeepStrictEqual(previous, item))
        invalid(`Conflicting data for element ${item.id} at identical version and nonce`)
      return
    }
    if (
      !previous ||
      Number(item.version) > Number(previous.version) ||
      (item.version === previous.version && Number(item.versionNonce) < Number(previous.versionNonce))
    )
      merged.set(String(item.id), item)
  })
  if (patch.files) files(patch.files)
  const images = { ...current.files }
  Object.entries(patch.files ?? {}).forEach(([key, file]) => {
    const previous = images[key]
    if (
      previous &&
      (previous.dataURL !== file.dataURL || previous.mimeType !== file.mimeType || previous.created !== file.created)
    )
      invalid(`File ${key} is immutable; use a new file id`)
    images[key] = previous
      ? {
          ...previous,
          ...(file.lastRetrieved === undefined
            ? {}
            : { lastRetrieved: Math.max(previous.lastRetrieved ?? 0, file.lastRetrieved) }),
        }
      : file
  })
  files(images)
  const elements = Array.from(merged.values())
  if (elements.length > Limits.elements || size(elements) > Limits.sceneBytes)
    invalid("Merged scene exceeds 5000 elements or 4 MiB")
  elements.forEach((item) => {
    if (
      item.type === "image" &&
      item.isDeleted !== true &&
      (typeof item.fileId !== "string" || !Object.hasOwn(images, item.fileId))
    )
      invalid(`Missing image file for ${item.id}`)
  })
  if (isDeepStrictEqual(elements, current.elements) && isDeepStrictEqual(images, current.files)) return current
  return { sessionID: current.sessionID, revision: current.revision + 1, elements, files: images, updatedAt: now }
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Snapshot, Whiteboard.NotFoundError>
  readonly update: (sessionID: SessionID, patch: Patch, actor: Actor) => Effect.Effect<Snapshot, Failure>
  readonly presence: (
    sessionID: SessionID,
    input: Whiteboard.PresenceInput,
  ) => Effect.Effect<Whiteboard.PresenceSnapshot, Failure>
  readonly participants: (sessionID: SessionID) => Effect.Effect<Whiteboard.PresenceSnapshot, Whiteboard.NotFoundError>
}
export class Service extends Context.Service<Service, Interface>()("@forge/Whiteboard") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = isWithReplicas(database.db) ? database.db.$primary : database.db
    const sessions = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const people = new Map<SessionID, Map<string, Whiteboard.Participant>>()
    const requireSession = Effect.fn(function* (sessionID: SessionID) {
      if (!(yield* sessions.get(sessionID))) {
        people.delete(sessionID)
        return yield* new Whiteboard.NotFoundError({ sessionID })
      }
    })
    const get = Effect.fn(function* (sessionID: SessionID) {
      yield* requireSession(sessionID)
      const row = yield* db
        .select()
        .from(SessionWhiteboardTable)
        .where(eq(SessionWhiteboardTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row
        ? { sessionID, revision: row.revision, elements: row.elements, files: row.files, updatedAt: row.updated_at }
        : { sessionID, revision: 0, elements: [], files: {}, updatedAt: 0 }
    })
    const clean = (now: number) => {
      people.forEach((participants, id) => {
        participants.forEach((person, key) => {
          if (person.updatedAt <= now - Limits.presenceTTL) participants.delete(key)
        })
        if (!participants.size) people.delete(id)
      })
    }
    return Service.of({
      get,
      update: (sessionID, patch, actor) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              const current = yield* get(sessionID)
              if (!Schema.is(Whiteboard.Actor)(actor))
                return yield* new Whiteboard.ValidationError({ message: "Invalid actor identity" })
              const next = yield* Effect.try({
                try: () => merge(current, patch),
                catch: (error) =>
                  error instanceof Whiteboard.ConflictError || error instanceof Whiteboard.ValidationError
                    ? error
                    : new Whiteboard.ValidationError({ message: "Invalid whiteboard JSON" }),
              })
              if (next === current) return current
              yield* events.publish(
                Whiteboard.Updated,
                { sessionID, revision: next.revision, actor },
                {
                  commit: () =>
                    db
                      .insert(SessionWhiteboardTable)
                      .values({
                        session_id: sessionID,
                        revision: next.revision,
                        elements: next.elements,
                        files: next.files,
                        updated_at: next.updatedAt,
                      })
                      .onConflictDoUpdate({
                        target: SessionWhiteboardTable.session_id,
                        set: {
                          revision: next.revision,
                          elements: next.elements,
                          files: next.files,
                          updated_at: next.updatedAt,
                        },
                      })
                      .run()
                      .pipe(Effect.orDie, Effect.asVoid),
                },
              )
              return next
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      participants: Effect.fn(function* (sessionID) {
        yield* requireSession(sessionID)
        const now = yield* Clock.currentTimeMillis
        clean(now)
        return { participants: Array.from(people.get(sessionID)?.values() ?? []) }
      }),
      presence: Effect.fn(function* (sessionID, input) {
        yield* requireSession(sessionID)
        if (
          !Schema.is(Whiteboard.PresenceInput)(input) ||
          (input.pointer &&
            (!Number.isFinite(input.pointer.x) ||
              !Number.isFinite(input.pointer.y) ||
              Math.abs(input.pointer.x) > 1e9 ||
              Math.abs(input.pointer.y) > 1e9))
        )
          return yield* new Whiteboard.ValidationError({ message: "Invalid presence identity, pointer or selection" })
        const now = yield* Clock.currentTimeMillis
        clean(now)
        const participants = people.get(sessionID) ?? new Map<string, Whiteboard.Participant>()
        if (
          (!people.has(sessionID) && people.size >= 1024) ||
          (!participants.has(input.clientID) && participants.size >= Limits.participants)
        )
          return yield* new Whiteboard.ValidationError({ message: "Presence capacity reached" })
        participants.set(input.clientID, { ...input, updatedAt: now })
        people.set(sessionID, participants)
        const snapshot = { participants: Array.from(participants.values()) }
        yield* events.publish(Whiteboard.Presence, { sessionID, ...snapshot })
        return snapshot
      }),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SessionStore.node, EventV2.node] })
