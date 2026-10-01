import { createHash } from "crypto"
import { types } from "node:util"
import type { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"
import { PriorWork } from "@turenlabs/schema/prior-work"
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Result, Schema, SchemaIssue } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Project } from "../project"
import { ProjectTable } from "../project/sql"
import { SecretPlaceholder } from "../secret-placeholder"
import {
  PriorWorkEventTable,
  PriorWorkIdempotencyTable,
  PriorWorkLinkTable,
  PriorWorkOriginTable,
  PriorWorkRecordTable,
  PriorWorkRepositoryTable,
  PriorWorkRevisionTable,
} from "./sql"

export const RecordID = PriorWork.RecordID
export type RecordID = PriorWork.RecordID
export const RepositoryID = PriorWork.RepositoryID
export type RepositoryID = PriorWork.RepositoryID
export const Limits = PriorWork.Limits
export type Actor = PriorWork.Actor
export type HumanActor = PriorWork.HumanActor
export type Written = PriorWork.Written
export type Detail = PriorWork.Detail
export type Page = PriorWork.Page
export const InvalidInput = PriorWork.InvalidInput
export type InvalidInput = PriorWork.InvalidInput
export const NotFound = PriorWork.NotFound
export type NotFound = PriorWork.NotFound
export const Conflict = PriorWork.Conflict
export type Conflict = PriorWork.Conflict
export const Forbidden = PriorWork.Forbidden
export type Forbidden = PriorWork.Forbidden
export const Unsupported = PriorWork.Unsupported
export type Unsupported = PriorWork.Unsupported
export type Failure = PriorWork.Failure

/**
 * Location-scoped prior work. Every read and write is confined to the Location's project and its
 * authorized repository set: its own binding plus the bindings an owner linked it to.
 *
 * Request inputs are `unknown` on purpose: they are screened for secret placeholders and then
 * decoded here, so no caller can skip the content-free rejection path. Actors are trusted
 * invocation context and are never taken from model input.
 */
export interface Interface {
  /** The Location's binding, or undefined while unbound. Never creates one. */
  readonly repository: () => Effect.Effect<RepositoryID | undefined, Unsupported>
  /** Create a record, or a new revision of one with compare-and-swap on its head. */
  readonly record: (input: unknown, actor: Actor) => Effect.Effect<Written, Failure>
  /** Create a record from a historical entry the trusted caller verified access to. */
  readonly adopt: (input: unknown, actor: Actor) => Effect.Effect<Written, Failure>
  readonly retract: (input: unknown, actor: Actor) => Effect.Effect<void, Failure>
  /** Human-only tombstone: drops revision content, keeps identity, origin, events, and relationships. */
  readonly delete: (id: RecordID, actor: HumanActor) => Effect.Effect<void, Failure>
  /** Human-only, one-directional, non-transitive grant from this Location's binding to `target`. */
  readonly link: (target: RepositoryID, actor: HumanActor) => Effect.Effect<RepositoryID, Failure>
  readonly get: (input: unknown) => Effect.Effect<Detail, Failure>
  readonly search: (input: unknown) => Effect.Effect<Page, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@forge/PriorWork") {}

type Transaction = Parameters<Parameters<EffectDrizzleSqlite.EffectSQLiteDatabase["transaction"]>[0]>[0]
type RecordRow = typeof PriorWorkRecordTable.$inferSelect
type RevisionRow = typeof PriorWorkRevisionTable.$inferSelect
type OriginRow = typeof PriorWorkOriginTable.$inferSelect
type Incarnation = { readonly dev: number; readonly ino: number; readonly birthtime: number }
type OriginValues = Omit<typeof PriorWorkOriginTable.$inferInsert, "record_id" | "repository_id">

const MAX_ERROR_PATHS = 16

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const projectID = location.project.id

    // The canonical common directory's filesystem incarnation. Its path only locates a binding.
    // Anything short of a device, inode, and birth time leaves the Location unbound: it sees no
    // prior work and cannot write any, rather than falling back to a path-derived identity.
    const incarnation = Effect.fn("PriorWork.incarnation")(function* () {
      if (projectID === Project.ID.global) return yield* new PriorWork.Unsupported({ reason: "global_project" })
      if (!location.vcs) return yield* new PriorWork.Unsupported({ reason: "not_git" })
      const real = yield* fs.realPath(location.vcs.store).pipe(Effect.option)
      if (Option.isNone(real)) return undefined
      const info = yield* fs.stat(real.value).pipe(Effect.option)
      if (Option.isNone(info) || info.value.type !== "Directory") return undefined
      const ino = Option.getOrUndefined(info.value.ino)
      const birthtime = Option.getOrUndefined(info.value.birthtime)?.getTime()
      if (!(info.value.dev > 0) || ino === undefined || !(ino > 0) || birthtime === undefined || !(birthtime > 0))
        return undefined
      return { dev: info.value.dev, ino, birthtime } satisfies Incarnation
    })

    // Drizzle failures retain query parameters; never expose them through a domain failure.
    const storageFailure = () => Effect.die(new Error("Prior work storage unavailable"))

    const transact = <A, E>(body: (tx: Transaction) => Effect.Effect<A, E>) =>
      db
        .transaction(body, { behavior: "immediate" })
        .pipe(Effect.catchTag("SqlError", storageFailure), Effect.catchDefect(storageFailure))

    const read = <A, E>(body: (tx: Transaction) => Effect.Effect<A, E>) =>
      db.transaction(body).pipe(Effect.catchTag("SqlError", storageFailure), Effect.catchDefect(storageFailure))

    const findBinding = Effect.fn("PriorWork.findBinding")(function* (tx: Transaction, found: Incarnation | undefined) {
      if (!found) return undefined
      const row = yield* tx
        .select({ id: PriorWorkRepositoryTable.id })
        .from(PriorWorkRepositoryTable)
        .where(
          and(
            eq(PriorWorkRepositoryTable.project_id, projectID),
            eq(PriorWorkRepositoryTable.dev, found.dev),
            eq(PriorWorkRepositoryTable.ino, found.ino),
            eq(PriorWorkRepositoryTable.birthtime, found.birthtime),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row?.id
    })

    const ensureBinding = Effect.fn("PriorWork.ensureBinding")(function* (
      tx: Transaction,
      found: Incarnation | undefined,
      now: number,
    ) {
      if (!found) return yield* new PriorWork.Unsupported({ reason: "unbound" })
      const existing = yield* findBinding(tx, found)
      if (existing) return existing
      yield* tx
        .insert(ProjectTable)
        .values({ id: projectID, worktree: location.project.directory, vcs: "git", sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const id = PriorWork.RepositoryID.create()
      yield* tx
        .insert(PriorWorkRepositoryTable)
        .values({ id, project_id: projectID, ...found, time_created: now })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const authorized = Effect.fn("PriorWork.authorized")(function* (
      tx: Transaction,
      binding: RepositoryID | undefined,
    ) {
      if (!binding) return []
      const links = yield* tx
        .select({ id: PriorWorkLinkTable.target_repository_id })
        .from(PriorWorkLinkTable)
        .where(eq(PriorWorkLinkTable.repository_id, binding))
        .all()
        .pipe(Effect.orDie)
      return [binding, ...links.map((link) => link.id)]
    })

    const findRecord = Effect.fn("PriorWork.findRecord")(function* (
      tx: Transaction,
      repositories: readonly RepositoryID[],
      id: RecordID,
      path: string,
    ) {
      const row =
        repositories.length === 0
          ? undefined
          : yield* tx
              .select()
              .from(PriorWorkRecordTable)
              .where(
                and(
                  eq(PriorWorkRecordTable.id, id),
                  eq(PriorWorkRecordTable.project_id, projectID),
                  inArray(PriorWorkRecordTable.repository_id, repositories),
                ),
              )
              .get()
              .pipe(Effect.orDie)
      if (!row) return yield* new PriorWork.NotFound({ path })
      return row
    })

    const findRevision = Effect.fn("PriorWork.findRevision")(function* (
      tx: Transaction,
      id: RecordID,
      revision: number,
    ) {
      return yield* tx
        .select()
        .from(PriorWorkRevisionTable)
        .where(and(eq(PriorWorkRevisionTable.record_id, id), eq(PriorWorkRevisionTable.revision, revision)))
        .get()
        .pipe(Effect.orDie)
    })

    // Resolve known sources within the recording binding, then validate authorized lineage.
    // Edits may retain an existing tombstone reference, but cannot invent a new one.
    const checkReferences = Effect.fn("PriorWork.checkReferences")(function* (
      tx: Transaction,
      repositories: readonly RepositoryID[],
      prepared: PriorWork.Prepared,
      binding: RepositoryID,
      previous?: RevisionRow,
    ) {
      const source =
        prepared.challenges && "unresolved" in prepared.challenges ? prepared.challenges.unresolved : undefined
      const adopted = source
        ? yield* tx
            .select({ id: PriorWorkOriginTable.record_id })
            .from(PriorWorkOriginTable)
            .where(
              and(
                eq(PriorWorkOriginTable.repository_id, binding),
                eq(PriorWorkOriginTable.source_kind, source.source),
                eq(PriorWorkOriginTable.source_id, source.source_id),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      const checked = adopted
        ? { ...prepared, challenges: { resolved: { record_id: adopted.id, revision: 1 } } }
        : prepared
      const references = [
        ...(checked.challenges && "resolved" in checked.challenges
          ? [{ ref: checked.challenges.resolved, path: "prepared.challenges.resolved", challenge: true }]
          : []),
        ...checked.derived_from.map((ref, index) => ({
          ref,
          path: `prepared.derived_from.${index}`,
          challenge: false,
        })),
      ]
      const previousReferences = [
        ...(previous?.challenges && "resolved" in previous.challenges
          ? [{ ref: previous.challenges.resolved, challenge: true }]
          : []),
        ...(previous?.derived_from ?? []).map((ref) => ({ ref, challenge: false })),
      ]
      yield* Effect.forEach(
        references,
        (item) =>
          Effect.gen(function* () {
            const record = yield* findRecord(tx, repositories, item.ref.record_id, item.path)
            if (
              record.state === "deleted" &&
              previousReferences.some(
                (entry) =>
                  entry.challenge === item.challenge &&
                  entry.ref.record_id === item.ref.record_id &&
                  entry.ref.revision === item.ref.revision,
              )
            )
              return undefined
            if (!(yield* findRevision(tx, item.ref.record_id, item.ref.revision)))
              return yield* new PriorWork.NotFound({ path: item.path })
            return undefined
          }),
        { discard: true },
      )
      return adopted ? yield* parse(PriorWork.Prepared, checked) : checked
    })

    const replay = Effect.fn("PriorWork.replay")(function* (
      tx: Transaction,
      repositories: readonly RepositoryID[],
      actor: Actor,
      key: string | undefined,
      hash: string,
    ) {
      if (key === undefined || actor.actor !== "agent") return undefined
      const row = yield* tx
        .select()
        .from(PriorWorkIdempotencyTable)
        .where(and(eq(PriorWorkIdempotencyTable.session_id, actor.session_id), eq(PriorWorkIdempotencyTable.key, key)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      if (row.intent_hash !== hash) return yield* new PriorWork.Conflict({ reason: "idempotency_mismatch" })
      // A replay never reveals a record outside the current Location's authorized set.
      yield* findRecord(tx, repositories, row.record_id, "key")
      return { id: row.record_id, revision: row.revision, replayed: true } satisfies Written
    })

    const remember = Effect.fn("PriorWork.remember")(function* (
      tx: Transaction,
      actor: Actor,
      key: string | undefined,
      hash: string,
      written: Written,
      now: number,
    ) {
      if (key === undefined || actor.actor !== "agent") return
      yield* tx
        .insert(PriorWorkIdempotencyTable)
        .values({
          session_id: actor.session_id,
          key,
          intent_hash: hash,
          record_id: written.id,
          revision: written.revision,
          time_created: now,
        })
        .run()
        .pipe(Effect.orDie)
    })

    const event = (
      tx: Transaction,
      input: {
        readonly repositoryID: RepositoryID
        readonly recordID?: RecordID
        readonly action: typeof PriorWorkEventTable.$inferInsert.action
        readonly actor: Actor
        readonly revision?: number
        readonly reason?: string
        readonly target?: RepositoryID
        readonly now: number
      },
    ) =>
      tx
        .insert(PriorWorkEventTable)
        .values({
          id: PriorWork.EventID.create(),
          project_id: projectID,
          repository_id: input.repositoryID,
          record_id: input.recordID ?? null,
          action: input.action,
          actor: input.actor,
          session_id: input.actor.actor === "agent" ? input.actor.session_id : null,
          revision: input.revision ?? null,
          reason: input.reason ?? null,
          target_repository_id: input.target ?? null,
          time_created: input.now,
        })
        .run()
        .pipe(Effect.orDie)

    const create = Effect.fn("PriorWork.create")(function* (
      tx: Transaction,
      binding: RepositoryID,
      prepared: PriorWork.Prepared,
      actor: Actor,
      origin: OriginValues,
      now: number,
    ) {
      const id = PriorWork.RecordID.create()
      yield* tx
        .insert(PriorWorkRecordTable)
        .values({
          id,
          project_id: projectID,
          repository_id: binding,
          kind: prepared.kind,
          head_revision: 1,
          state: "active",
          recording_session_id: actor.actor === "agent" ? actor.session_id : null,
          time_created: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* tx
        .insert(PriorWorkRevisionTable)
        .values(revisionValues(id, 1, prepared, { basis: "unknown" }, actor, now))
        .run()
        .pipe(Effect.orDie)
      yield* tx
        .insert(PriorWorkOriginTable)
        .values({ ...origin, record_id: id, repository_id: binding })
        .run()
        .pipe(Effect.orDie)
      yield* event(tx, {
        repositoryID: binding,
        recordID: id,
        action: origin.source_kind === "live" ? "create" : "adopt",
        actor,
        revision: 1,
        now,
      })
      return { id, revision: 1, replayed: false } satisfies Written
    })

    // Writes the next revision of `record` whose head must still be `head`. A new revision keeps
    // the previous revision's observation: a prose correction never refreshes it.
    const append = Effect.fn("PriorWork.append")(function* (
      tx: Transaction,
      record: RecordRow,
      head: number,
      prepared: PriorWork.Prepared,
      actor: Actor,
      now: number,
    ) {
      const previous = yield* findRevision(tx, record.id, head)
      if (!previous) return yield* new PriorWork.Conflict({ reason: "stale_head" })
      const revision = head + 1
      const moved = yield* tx
        .update(PriorWorkRecordTable)
        .set({ head_revision: revision })
        .where(
          and(
            eq(PriorWorkRecordTable.id, record.id),
            eq(PriorWorkRecordTable.head_revision, head),
            eq(PriorWorkRecordTable.state, "active"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!moved) return yield* new PriorWork.Conflict({ reason: "stale_head" })
      yield* tx
        .insert(PriorWorkRevisionTable)
        .values(revisionValues(record.id, revision, prepared, previous.observation, actor, now))
        .run()
        .pipe(Effect.orDie)
      yield* event(tx, {
        repositoryID: record.repository_id,
        recordID: record.id,
        action: "revise",
        actor,
        revision,
        now,
      })
      return { id: record.id, revision, replayed: false } satisfies Written
    })

    // Refutations that challenge a not-yet-adopted source entry are resolved to the adopted
    // record's first revision, the one derived from that source. Only records in the adopting
    // binding are rewritten; linked bindings keep their own lineage.
    const resolvePending = Effect.fn("PriorWork.resolvePending")(function* (
      tx: Transaction,
      binding: RepositoryID,
      source: PriorWork.SourceRef,
      adopted: RecordID,
      actor: Actor,
      now: number,
    ) {
      const pending = yield* tx
        .select({ record: PriorWorkRecordTable, revision: PriorWorkRevisionTable })
        .from(PriorWorkRecordTable)
        .innerJoin(
          PriorWorkRevisionTable,
          and(
            eq(PriorWorkRevisionTable.record_id, PriorWorkRecordTable.id),
            eq(PriorWorkRevisionTable.revision, PriorWorkRecordTable.head_revision),
          ),
        )
        .where(
          and(
            eq(PriorWorkRecordTable.project_id, projectID),
            eq(PriorWorkRecordTable.repository_id, binding),
            eq(PriorWorkRecordTable.state, "active"),
            sql`json_extract(${PriorWorkRevisionTable.challenges}, '$.unresolved.source') = ${source.source}`,
            sql`json_extract(${PriorWorkRevisionTable.challenges}, '$.unresolved.source_id') = ${source.source_id}`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        pending,
        (row) =>
          append(
            tx,
            row.record,
            row.record.head_revision,
            {
              ...preparedFromRow(row.record, row.revision),
              challenges: { resolved: { record_id: adopted, revision: 1 } },
            },
            actor,
            now,
          ),
        { discard: true },
      )
    })

    const requireActive = (record: RecordRow) =>
      record.state === "active" ? Effect.void : Effect.fail(new PriorWork.Conflict({ reason: "record_not_active" }))

    const requireModifier = (record: RecordRow, actor: Actor) =>
      actor.actor === "human" ||
      (record.recording_session_id !== null && record.recording_session_id === actor.session_id)
        ? Effect.void
        : Effect.fail(new PriorWork.Forbidden({ reason: "not_recorder" }))

    const requireHuman = (actor: Actor) =>
      actor.actor === "human" ? Effect.void : Effect.fail(new PriorWork.Forbidden({ reason: "human_only" }))

    const revise = Effect.fn("PriorWork.revise")(function* (
      tx: Transaction,
      repositories: readonly RepositoryID[],
      target: { readonly id: RecordID; readonly head: number },
      prepared: PriorWork.Prepared,
      actor: Actor,
      now: number,
    ) {
      const record = yield* findRecord(tx, repositories, target.id, "target.id")
      yield* requireActive(record)
      yield* requireModifier(record, actor)
      if (record.kind !== prepared.kind) return yield* new PriorWork.Forbidden({ reason: "kind_immutable" })
      if (record.head_revision !== target.head) return yield* new PriorWork.Conflict({ reason: "stale_head" })
      const previous = yield* findRevision(tx, record.id, target.head)
      if (!previous) return yield* new PriorWork.Conflict({ reason: "stale_head" })
      const checked = yield* checkReferences(tx, repositories, prepared, record.repository_id, previous)
      return yield* append(tx, record, target.head, checked, actor, now)
    })

    return Service.of({
      repository: Effect.fn("PriorWork.repository")(function* () {
        const found = yield* incarnation()
        return yield* read((tx) => findBinding(tx, found))
      }),

      record: Effect.fn("PriorWork.record")(function* (input: unknown, actor: Actor) {
        const request = yield* parse(PriorWork.RecordRequest, input)
        const found = yield* incarnation()
        const hash = intent("record", request)
        const now = Date.now()
        return yield* transact((tx) =>
          Effect.gen(function* () {
            const binding = yield* ensureBinding(tx, found, now)
            const repositories = yield* authorized(tx, binding)
            const replayed = yield* replay(tx, repositories, actor, request.key, hash)
            if (replayed) return replayed
            const prepared = request.target
              ? request.prepared
              : yield* checkReferences(tx, repositories, request.prepared, binding)
            const written = request.target
              ? yield* revise(tx, repositories, request.target, prepared, actor, now)
              : yield* create(tx, binding, prepared, actor, liveOrigin(actor, now), now)
            yield* remember(tx, actor, request.key, hash, written, now)
            return written
          }),
        )
      }),

      adopt: Effect.fn("PriorWork.adopt")(function* (input: unknown, actor: Actor) {
        const request = yield* parse(PriorWork.AdoptRequest, input)
        const found = yield* incarnation()
        const hash = intent("adopt", request)
        const now = Date.now()
        return yield* transact((tx) =>
          Effect.gen(function* () {
            const binding = yield* ensureBinding(tx, found, now)
            const repositories = yield* authorized(tx, binding)
            const replayed = yield* replay(tx, repositories, actor, request.key, hash)
            if (replayed) return replayed
            const prepared = yield* checkReferences(tx, repositories, request.prepared, binding)
            const existing = yield* tx
              .select({ id: PriorWorkOriginTable.record_id })
              .from(PriorWorkOriginTable)
              .where(
                and(
                  eq(PriorWorkOriginTable.repository_id, binding),
                  eq(PriorWorkOriginTable.source_kind, request.origin.source),
                  eq(PriorWorkOriginTable.source_id, request.origin.source_id),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (existing) return yield* new PriorWork.Conflict({ reason: "already_adopted" })
            const written = yield* create(
              tx,
              binding,
              prepared,
              actor,
              {
                author: request.origin.author,
                source_kind: request.origin.source,
                source_id: request.origin.source_id,
                source_root_session_id: request.origin.root_session_id,
                source_session_id: request.origin.source_session_id ?? null,
                time_observed: request.origin.time_observed,
              },
              now,
            )
            yield* resolvePending(
              tx,
              binding,
              { source: request.origin.source, source_id: request.origin.source_id },
              written.id,
              actor,
              now,
            )
            yield* remember(tx, actor, request.key, hash, written, now)
            return written
          }),
        )
      }),

      retract: Effect.fn("PriorWork.retract")(function* (input: unknown, actor: Actor) {
        const request = yield* parse(PriorWork.RetractRequest, input)
        const found = yield* incarnation()
        const now = Date.now()
        yield* transact((tx) =>
          Effect.gen(function* () {
            const repositories = yield* authorized(tx, yield* findBinding(tx, found))
            const record = yield* findRecord(tx, repositories, request.id, "id")
            yield* requireActive(record)
            yield* requireModifier(record, actor)
            yield* tx
              .update(PriorWorkRecordTable)
              .set({ state: "retracted" })
              .where(and(eq(PriorWorkRecordTable.id, record.id), eq(PriorWorkRecordTable.state, "active")))
              .run()
              .pipe(Effect.orDie)
            yield* event(tx, {
              repositoryID: record.repository_id,
              recordID: record.id,
              action: "retract",
              actor,
              revision: record.head_revision,
              reason: request.reason,
              now,
            })
          }),
        )
      }),

      delete: Effect.fn("PriorWork.delete")(function* (id: RecordID, actor: HumanActor) {
        yield* requireHuman(actor)
        const found = yield* incarnation()
        const now = Date.now()
        yield* transact((tx) =>
          Effect.gen(function* () {
            const repositories = yield* authorized(tx, yield* findBinding(tx, found))
            const record = yield* findRecord(tx, repositories, id, "id")
            if (record.state === "deleted") return
            yield* tx
              .delete(PriorWorkRevisionTable)
              .where(eq(PriorWorkRevisionTable.record_id, record.id))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(PriorWorkRecordTable)
              .set({ state: "deleted" })
              .where(eq(PriorWorkRecordTable.id, record.id))
              .run()
              .pipe(Effect.orDie)
            // Retraction reasons are record content too.
            yield* tx
              .update(PriorWorkEventTable)
              .set({ reason: null })
              .where(eq(PriorWorkEventTable.record_id, record.id))
              .run()
              .pipe(Effect.orDie)
            yield* event(tx, {
              repositoryID: record.repository_id,
              recordID: record.id,
              action: "delete",
              actor,
              revision: record.head_revision,
              now,
            })
          }),
        )
      }),

      link: Effect.fn("PriorWork.link")(function* (target: RepositoryID, actor: HumanActor) {
        yield* requireHuman(actor)
        const found = yield* incarnation()
        const now = Date.now()
        return yield* transact((tx) =>
          Effect.gen(function* () {
            const binding = yield* ensureBinding(tx, found, now)
            if (binding === target) return yield* new PriorWork.InvalidInput({ reason: "malformed", paths: ["target"] })
            const exists = yield* tx
              .select({ id: PriorWorkRepositoryTable.id })
              .from(PriorWorkRepositoryTable)
              .where(and(eq(PriorWorkRepositoryTable.id, target), eq(PriorWorkRepositoryTable.project_id, projectID)))
              .get()
              .pipe(Effect.orDie)
            if (!exists) return yield* new PriorWork.NotFound({ path: "target" })
            const linked = yield* tx
              .insert(PriorWorkLinkTable)
              .values({ repository_id: binding, target_repository_id: target, time_created: now })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (linked) yield* event(tx, { repositoryID: binding, action: "link", actor, target, now })
            return binding
          }),
        )
      }),

      get: Effect.fn("PriorWork.get")(function* (input: unknown) {
        const request = yield* parse(PriorWork.GetRequest, input)
        const found = yield* incarnation()
        return yield* read((tx) =>
          Effect.gen(function* () {
            const repositories = yield* authorized(tx, yield* findBinding(tx, found))
            const record = yield* findRecord(tx, repositories, request.id, "id")
            const origin = yield* tx
              .select()
              .from(PriorWorkOriginTable)
              .where(eq(PriorWorkOriginTable.record_id, record.id))
              .get()
              .pipe(Effect.orDie)
            if (!origin) return yield* Effect.die(new Error("Prior work record has no origin"))
            const head = yield* findRevision(tx, record.id, record.head_revision)
            const revision =
              request.revision === undefined || request.revision === record.head_revision
                ? head
                : yield* findRevision(tx, record.id, request.revision)
            if (request.revision !== undefined && !revision && record.state !== "deleted")
              return yield* new PriorWork.NotFound({ path: "revision" })
            return {
              record: summarize(record, origin, head?.summary),
              revision: revision ? revisionFromRow(revision) : undefined,
            } satisfies Detail
          }),
        )
      }),

      search: Effect.fn("PriorWork.search")(function* (input: unknown) {
        const request = yield* parse(PriorWork.SearchInput, input)
        const found = yield* incarnation()
        const limit = request.limit ?? PriorWork.Limits.pageSize
        return yield* read((tx) =>
          Effect.gen(function* () {
            const repositories = yield* authorized(tx, yield* findBinding(tx, found))
            if (repositories.length === 0) return { items: [] } satisfies Page
            const rows = yield* tx
              .select({
                record: PriorWorkRecordTable,
                origin: PriorWorkOriginTable,
                summary: PriorWorkRevisionTable.summary,
              })
              .from(PriorWorkRecordTable)
              .innerJoin(PriorWorkOriginTable, eq(PriorWorkOriginTable.record_id, PriorWorkRecordTable.id))
              .innerJoin(
                PriorWorkRevisionTable,
                and(
                  eq(PriorWorkRevisionTable.record_id, PriorWorkRecordTable.id),
                  eq(PriorWorkRevisionTable.revision, PriorWorkRecordTable.head_revision),
                ),
              )
              .where(
                and(
                  eq(PriorWorkRecordTable.project_id, projectID),
                  inArray(PriorWorkRecordTable.repository_id, repositories),
                  request.kind ? eq(PriorWorkRecordTable.kind, request.kind) : undefined,
                  request.cursor ? lt(PriorWorkRecordTable.id, request.cursor) : undefined,
                  request.author?.actor
                    ? sql`json_extract(${PriorWorkOriginTable.author}, '$.actor') = ${request.author.actor}`
                    : undefined,
                  request.author?.agent
                    ? sql`json_extract(${PriorWorkOriginTable.author}, '$.agent') = ${request.author.agent}`
                    : undefined,
                  request.author?.name
                    ? sql`json_extract(${PriorWorkOriginTable.author}, '$.name') = ${request.author.name}`
                    : undefined,
                  request.text ? textFilter(request.text) : undefined,
                  request.path ? pathFilter(request.path) : undefined,
                ),
              )
              .orderBy(desc(PriorWorkRecordTable.id))
              .limit(limit + 1)
              .all()
              .pipe(Effect.orDie)
            const items = rows.slice(0, limit).map((row) => summarize(row.record, row.origin, row.summary))
            const last = items.at(-1)
            return { items, cursor: rows.length > limit && last ? last.id : undefined } satisfies Page
          }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, FSUtil.node, Location.node],
})

/**
 * Screens raw input for secret placeholders before decoding, then decodes it. Failures carry a
 * fixed reason and schema key paths only: submitted values and unknown submitted keys never reach
 * the error.
 */
function parse<S extends Schema.Decoder<unknown> & { readonly fields: Schema.Struct.Fields }>(
  schema: S,
  input: unknown,
) {
  if (SecretPlaceholder.containsPlaceholder(input))
    return Effect.fail(new PriorWork.InvalidInput({ reason: "placeholder", paths: placeholderFields(schema, input) }))
  const decoded = Schema.decodeUnknownResult(schema, { errors: "all" })(input)
  if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success)
  const issues = collect(decoded.failure.issue, [])
  return Effect.fail(
    new PriorWork.InvalidInput({
      reason: issues.some((issue) => issue.tooLarge) ? "too_large" : "malformed",
      paths: [...new Set(issues.map((issue) => issue.path))].slice(0, MAX_ERROR_PATHS),
    }),
  )
}

// Only the schema's own top-level field names are reported, and only when reading them cannot run
// caller code. Unwalkable input reports no paths.
function placeholderFields(schema: { readonly fields: Schema.Struct.Fields }, input: unknown) {
  if (typeof input !== "object" || input === null || types.isProxy(input)) return []
  return Object.keys(schema.fields).filter((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor) return false
    if (!("value" in descriptor)) return true
    return SecretPlaceholder.containsPlaceholder(descriptor.value)
  })
}

function collect(issue: SchemaIssue.Issue, path: readonly PropertyKey[]): { path: string; tooLarge: boolean }[] {
  if (issue._tag === "Pointer") return collect(issue.issue, [...path, ...issue.path])
  if (issue._tag === "Composite") return issue.issues.flatMap((item) => collect(item, path))
  if (issue._tag === "AnyOf" && issue.issues.length > 0) return issue.issues.flatMap((item) => collect(item, path))
  if (issue._tag === "Encoding") return collect(issue.issue, path)
  if (issue._tag === "Filter") {
    const tooLarge = issue.filter.annotations?.expected === PriorWork.BYTE_LIMIT || maxLength(issue.filter)
    return collect(issue.issue, path).map((item) => ({ path: item.path, tooLarge: item.tooLarge || tooLarge }))
  }
  // UnexpectedKey paths would name a key the caller invented; report its parent instead.
  const keys = issue._tag === "UnexpectedKey" ? path.slice(0, -1) : path
  return [{ path: keys.map(String).join(".") || "(root)", tooLarge: false }]
}

function maxLength(filter: { readonly annotations?: { readonly meta?: unknown } | undefined }) {
  const meta = filter.annotations?.meta
  return typeof meta === "object" && meta !== null && "_tag" in meta && meta._tag === "isMaxLength"
}

/** SHA-256 of the canonical submitted intent: sorted keys, undefined fields omitted. */
function intent(operation: string, value: unknown) {
  return createHash("sha256").update(canonical({ operation, value })).digest("hex")
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map((entry) => `${JSON.stringify(entry[0])}:${canonical(entry[1])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function liveOrigin(actor: Actor, now: number): OriginValues {
  return {
    author: actor.actor === "agent" ? { actor: "agent", agent: actor.agent } : { actor: "human", name: actor.name },
    source_kind: "live",
    source_id: null,
    source_root_session_id: null,
    source_session_id: actor.actor === "agent" ? actor.session_id : null,
    time_observed: now,
  }
}

function recordedBy(actor: Actor): PriorWork.RecordedBy {
  if (actor.actor === "agent") return { actor: "agent", session_id: actor.session_id, agent: actor.agent }
  return { actor: "human", name: actor.name }
}

function revisionValues(
  id: RecordID,
  revision: number,
  prepared: PriorWork.Prepared,
  observation: PriorWork.Observation,
  actor: Actor,
  now: number,
): typeof PriorWorkRevisionTable.$inferInsert {
  return {
    record_id: id,
    revision,
    summary: prepared.summary,
    detail: prepared.detail,
    method: prepared.method,
    assumptions: prepared.assumptions,
    locations: prepared.locations,
    evidence: prepared.evidence,
    challenges: prepared.challenges ?? null,
    derived_from: prepared.derived_from,
    // Rollout step 2 (applicability) fills the whole-repository capture.
    recording_capture: null,
    observation,
    recorded_by: recordedBy(actor),
    time_recorded: now,
  }
}

function preparedFromRow(record: RecordRow, row: RevisionRow): PriorWork.Prepared {
  return {
    kind: record.kind,
    summary: row.summary,
    detail: row.detail,
    method: row.method,
    assumptions: row.assumptions,
    locations: row.locations,
    evidence: row.evidence,
    challenges: row.challenges ?? undefined,
    derived_from: row.derived_from,
  }
}

function revisionFromRow(row: RevisionRow): PriorWork.Revision {
  return {
    recordID: row.record_id,
    revision: row.revision,
    summary: row.summary,
    detail: row.detail,
    method: row.method,
    assumptions: row.assumptions,
    locations: row.locations,
    evidence: row.evidence,
    challenges: row.challenges ?? undefined,
    derivedFrom: row.derived_from,
    recordingCapture: row.recording_capture ?? undefined,
    observation: row.observation,
    recordedBy: row.recorded_by,
    timeRecorded: row.time_recorded,
  }
}

function summarize(record: RecordRow, origin: OriginRow, summary: string | undefined): PriorWork.Summary {
  return {
    id: record.id,
    repositoryID: record.repository_id,
    kind: record.kind,
    state: record.state,
    headRevision: record.head_revision,
    summary: record.state === "deleted" ? undefined : summary,
    author: origin.author,
    source:
      origin.source_kind === "live" || origin.source_id === null || origin.source_root_session_id === null
        ? { kind: "live" }
        : { kind: origin.source_kind, source_id: origin.source_id, root_session_id: origin.source_root_session_id },
    sourceSessionID: origin.source_session_id ?? undefined,
    timeObserved: origin.time_observed,
    timeCreated: record.time_created,
  }
}

function textFilter(text: string) {
  const pattern = `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
  return sql`(${PriorWorkRevisionTable.summary} LIKE ${pattern} ESCAPE '\\' OR ${PriorWorkRevisionTable.detail} LIKE ${pattern} ESCAPE '\\')`
}

/** Matches records anchored at `prefix` itself or anywhere beneath it. */
function pathFilter(prefix: string) {
  const normalized = prefix.replace(/\/+$/, "")
  const anchor = sql`coalesce(json_extract(anchor.value, '$.path'), json_extract(anchor.value, '$.directory'))`
  return sql`EXISTS (SELECT 1 FROM json_each(${PriorWorkRevisionTable.locations}) AS anchor WHERE ${anchor} = ${normalized} OR substr(${anchor}, 1, ${normalized.length + 1}) = ${`${normalized}/`})`
}
