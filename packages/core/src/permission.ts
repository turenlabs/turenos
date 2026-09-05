export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Fiber, Layer, Option, Schema, Semaphore } from "effect"
import path from "path"
import { Permission } from "@turenlabs/schema/permission"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { evaluate } from "./permission/rules"
import { PermissionSaved } from "./permission/saved"
import { PermissionChecks } from "./permission-checks"
import { SessionTaskV2 } from "./session/task"
import { FSUtil } from "./fs-util"

export { Effect, Rule, Ruleset } from "@turenlabs/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export { evaluate } from "./permission/rules"

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

const canonicalTargetsKey = "canonicalTargets"

export const mutationMetadata = (targets: ReadonlyArray<string>) => ({
  [canonicalTargetsKey]: [...targets],
})

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
  watcher?: Fiber.Fiber<void, never>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const checks = yield* PermissionChecks.Service
    const tasks = yield* SessionTaskV2.Service
    const pending = new Map<ID, Pending>()
    const completion = Semaphore.makeUnsafe(1)

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      const lobby = LobbySession.binding(session.metadata)
      const lobbyRules = Option.isSome(lobby)
        ? [LobbySession.capabilityRules(LobbySession.capabilityProfile(lobby.value))]
        : []
      const authority = yield* tasks.authority(sessionID)
      if (!authority) return { rulesets: [agent?.permissions ?? missingAgentPermissions, ...lobbyRules] }
      return {
        rulesets: [
          authority.parentPermissions,
          ...authority.ancestorPermissionSets,
          authority.childPermissions,
          authority.hardPermissions,
          ...lobbyRules,
        ],
        exactCommands: authority.commands,
        writeRoots: authority.writeRoots,
      }
    })

    function effect(input: AssertInput, rulesets: ReadonlyArray<Permission.Ruleset>, resource: string) {
      const effects = rulesets.map((rules) => evaluate(input.action, resource, rules).effect)
      if (effects.includes("deny")) return "deny" as const
      if (effects.includes("ask")) return "ask" as const
      return "allow" as const
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    function violatesTaskBoundary(
      input: AssertInput,
      configuration: {
        readonly exactCommands?: ReadonlyArray<string>
        readonly writeRoots?: ReadonlyArray<string>
      },
    ) {
      if (
        configuration.exactCommands &&
        input.action === "bash" &&
        (input.resources.some((resource) => !configuration.exactCommands?.includes(resource)) ||
          input.metadata?.workdir !== ".")
      )
        return true
      if (!configuration.writeRoots || (input.action !== "edit" && input.action !== "external_directory")) return false
      const targets = input.metadata?.[canonicalTargetsKey]
      if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== "string"))
        return true
      return targets.some(
        (target) =>
          !path.isAbsolute(target) || !configuration.writeRoots?.some((root) => FSUtil.contains(root, target)),
      )
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const configuration = yield* configured(input.sessionID, input.agent)
      const rules = configuration.rulesets.flat()
      if (violatesTaskBoundary(input, configuration))
        return {
          effect: "deny" as const,
          rules: [...rules, { action: input.action, resource: "*", effect: "deny" as const }],
        }
      const configuredEffects = input.resources.map((resource) => effect(input, configuration.rulesets, resource))
      if (configuredEffects.includes("deny")) return { effect: "deny" as const, rules }
      const saved = yield* savedRules()
      const effects = input.resources.map((resource, index) =>
        configuredEffects[index] === "ask" && evaluate(input.action, resource, saved).effect === "allow"
          ? "allow"
          : configuredEffects[index]!,
      )
      const result: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      if (result !== "ask" || (yield* checks.enforced())) return { effect: result, rules: [...rules, ...saved] }
      return { effect: "allow" as const, rules: [...rules, ...saved] }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const releaseWhenDisabled = (item: Pending) =>
      EffectRuntime.gen(function* () {
        const disabled = yield* checks.untilDisabled().pipe(
          EffectRuntime.as(true),
          EffectRuntime.raceFirst(
            Deferred.await(item.deferred).pipe(
              EffectRuntime.as(false),
              EffectRuntime.catch(() => EffectRuntime.succeed(false)),
            ),
          ),
        )
        if (!disabled) return
        yield* completion.withPermit(
          EffectRuntime.gen(function* () {
            if (pending.get(item.request.id) !== item) return
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "once",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(item.request.id)
          }),
        )
      })

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item: Pending = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          item.watcher = yield* releaseWhenDisabled(item).pipe(EffectRuntime.forkDetach({ startImmediately: true }))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              completion.withPermit(
                EffectRuntime.gen(function* () {
                  if (pending.get(item.request.id) !== item) return
                  if (item.watcher)
                    yield* Fiber.interrupt(item.watcher).pipe(
                      EffectRuntime.forkDetach({ startImmediately: true }),
                      EffectRuntime.asVoid,
                    )
                  pending.delete(item.request.id)
                }),
              ),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      completion.withPermit(
        EffectRuntime.uninterruptible(
          EffectRuntime.gen(function* () {
            const existing = pending.get(input.requestID)
            if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
            yield* events.publish(Event.Replied, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              reply: input.reply,
            })

            if (input.reply === "reject") {
              yield* Deferred.fail(
                existing.deferred,
                input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
              )
              pending.delete(input.requestID)
              for (const [id, item] of pending) {
                if (item.request.sessionID !== existing.request.sessionID) continue
                yield* events.publish(Event.Replied, {
                  sessionID: item.request.sessionID,
                  requestID: item.request.id,
                  reply: "reject",
                })
                yield* Deferred.fail(item.deferred, new DeclinedError())
                pending.delete(id)
              }
              return
            }

            if (input.reply === "always" && existing.request.save?.length) {
              yield* saved.add({
                projectID: location.project.id,
                action: existing.request.action,
                resources: existing.request.save,
              })
            }
            yield* Deferred.succeed(existing.deferred, undefined)
            pending.delete(input.requestID)
            if (input.reply !== "always" || !existing.request.save?.length) return

            const rememberedRules = yield* savedRules()
            for (const [id, item] of pending) {
              const input = { ...item.request }
              const configuration = yield* configured(item.request.sessionID, item.agent).pipe(
                EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
              )
              if (!configuration) continue
              if (violatesTaskBoundary(input, configuration)) continue
              const configuredEffects = item.request.resources.map((resource) =>
                effect(input, configuration.rulesets, resource),
              )
              if (configuredEffects.includes("deny")) continue
              if (
                !item.request.resources.every(
                  (resource, index) =>
                    configuredEffects[index] === "allow" ||
                    evaluate(item.request.action, resource, rememberedRules).effect === "allow",
                )
              )
                continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "always",
              })
              yield* Deferred.succeed(item.deferred, undefined)
              pending.delete(id)
            }
          }),
        ),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    Location.node,
    AgentV2.node,
    SessionStore.node,
    PermissionSaved.node,
    PermissionChecks.node,
    SessionTaskV2.node,
  ],
})
