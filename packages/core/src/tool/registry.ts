export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@turenlabs/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ToolInterceptor } from "./interceptor"
import {
  definition,
  isDeferred,
  permission,
  retryableError,
  settle,
  validateName,
  type AnyTool,
  type RegistrationError,
} from "./tool"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { ToolVisibleError } from "./visible-error"
import { ToolExecution } from "./execution"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly inline?: boolean
  readonly executeWithPermit?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export type MaterializeInput = {
  readonly permissions?: PermissionV2.Ruleset
  /** Separate authority ceilings. A whole-tool deny in any set hides the tool. */
  readonly permissionSets?: ReadonlyArray<PermissionV2.Ruleset>
  /** Canonical tools visible only to this provider turn. */
  readonly session?: Readonly<Record<string, AnyTool>>
  /**
   * Deferral view for this materialization. When present, a deferred registration whose name
   * is absent from both sets stays settleable — a direct call by name still executes — but is
   * withheld from `definitions`. When absent, deferred tools are advertised inline like any
   * other registration.
   */
  readonly deferred?: {
    readonly selected: ReadonlySet<string>
    readonly forceInline?: ReadonlySet<string>
  }
  /** Parent context made available to child-control tools when they admit child prompts. */
  readonly subagentPromptContext?: Pick<Tool.SubagentPromptContext, "harnessSnapshot">
}

export interface Interface {
  readonly materialize: (input?: PermissionV2.Ruleset | MaterializeInput) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
  /**
   * Registers an installer run before the first materialization of a turn.
   *
   * A source whose discovery is expensive enough that doing it at Location-graph
   * construction would be wrong registers here instead, so it is touched only once a
   * session actually assembles tools. `ensure` is expected to be idempotent; the
   * registry calls it on every materialization and relies on the caller to memoize.
   */
  readonly provision: (ensure: Effect.Effect<void>) => Effect.Effect<void>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  /**
   * Every deferred registration that survived permission filtering — name, description, and
   * permission action only, never a schema. `selected` reports whether the definition was
   * advertised this turn.
   */
  readonly deferred: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly action: string
    readonly selected: boolean
  }>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
  readonly completeTurn: (input: ToolInterceptor.TurnEvent) => Effect.Effect<void>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const interceptors = yield* ToolInterceptor.Service
    const resources = yield* ToolOutputStore.Service
    const executions = yield* ToolExecution.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const provisions = new Set<Effect.Effect<void>>()

    const executeRegistration = Effect.fn("ToolRegistry.executeRegistration")(function* (
      input: ExecuteInput,
      registration: Registration,
      call: ToolCall,
      subagentContext?: Tool.SubagentPromptContext,
    ) {
      const pending = yield* settle(registration.tool, call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        ...(subagentContext && Tool.requiresSubagentContext(registration.tool) ? { subagentContext } : {}),
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: ToolVisibleError.make(failure) } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    /**
     * The one settlement boundary, and therefore the one place plugin interceptors run.
     *
     * `before` sees the raw provider arguments, because that is the only representation where a
     * replacement still means anything: whatever it hands back is re-decoded by the tool's own
     * input schema below, so an interceptor cannot smuggle in a shape the tool never validated.
     * `after` sees the settled result, after execution, output encoding and generic bounding --
     * the exact value the model is about to be shown.
     *
     * Deliberately *not* here: `settleWith`'s unknown/stale-tool early returns. Nothing executes
     * on those paths, so there is no call to influence and no result to observe.
     */
    const settleRegistration = Effect.fn("ToolRegistry.settleRegistration")(function* (
      input: ExecuteInput,
      registration: Registration,
      subagentContext?: Tool.SubagentPromptContext,
    ) {
      const identity = {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        callID: input.call.id,
        tool: input.call.name,
      }
      return yield* executions.execute(
        {
          sessionID: input.sessionID,
          assistantMessageID: input.assistantMessageID,
          callID: input.call.id,
          tool: input.call.name,
          input: input.call.input,
          retryableError: retryableError(registration.tool),
        },
        Effect.gen(function* () {
          const decision = yield* interceptors.runBefore({ ...identity, input: input.call.input })
          if (decision.type === "deny") {
            const result = { type: "error" as const, value: decision.reason }
            if (input.inline) yield* interceptors.runTurnComplete(identity)
            yield* interceptors.awaitTurnComplete(identity)
            // Observers still see the denial rather than a call that silently vanished, but notes on
            // a call that never ran have nothing to annotate.
            yield* interceptors.runAfter({ ...identity, input: input.call.input, result, denied: true })
            return { result }
          }
          const call = decision.input === input.call.input ? input.call : { ...input.call, input: decision.input }
          const execution = executeRegistration(input, registration, call, subagentContext)
          const settlement = yield* input.executeWithPermit ? input.executeWithPermit(execution) : execution
          if (input.inline) yield* interceptors.runTurnComplete(identity)
          yield* interceptors.awaitTurnComplete(identity)
          const notes = yield* interceptors.runAfter({
            ...identity,
            input: call.input,
            result: settlement.result,
            denied: false,
          })
          return notes.length === 0 ? settlement : annotate(settlement, notes)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (input.inline) yield* interceptors.runTurnComplete(identity)
              yield* interceptors.runFinally(identity)
            }),
          ),
        ),
      )
    })

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: object,
      subagentContext?: Tool.SubagentPromptContext,
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      return yield* settleRegistration(input, registration, subagentContext)
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (input = []) {
        // Demand-driven sources install here rather than at layer build, so a Location
        // graph built for a request that never runs a turn never reaches them.
        yield* Effect.forEach(provisions, (ensure) => ensure, { discard: true })
        const options = (Array.isArray(input) ? { permissions: input } : input) as MaterializeInput
        const permissionSets = options.permissionSets ?? [options.permissions ?? []]
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        const session = new Set<string>()
        for (const [name, tool] of Object.entries(options.session ?? {})) {
          yield* validateName(name).pipe(Effect.orDie)
          registrations.set(name, { identity: {}, tool })
          session.add(name)
        }
        for (const [name, registration] of registrations)
          if (permissionSets.some((rules) => whollyDisabled(permission(registration.tool, name), rules)))
            registrations.delete(name)
        const deferred: Materialization["deferred"][number][] = []
        const definitions: ToolDefinition[] = []
        for (const [name, registration] of registrations) {
          const advertised = definition(name, registration.tool)
          if (!isDeferred(registration.tool)) {
            definitions.push(advertised)
            continue
          }
          const selected =
            options.deferred === undefined ||
            options.deferred.selected.has(name) ||
            options.deferred.forceInline?.has(name) === true
          deferred.push({
            name,
            description: advertised.description,
            action: permission(registration.tool, name),
            selected,
          })
          if (selected) definitions.push(advertised)
        }
        const subagentContext = options.subagentPromptContext
          ? {
              toolDefinitions: definitions,
              harnessSnapshot: options.subagentPromptContext.harnessSnapshot,
            }
          : undefined
        return {
          definitions,
          deferred,
          completeTurn: interceptors.runTurnComplete,
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration && session.has(input.call.name))
              return settleRegistration(input, registration, subagentContext)
            if (registration) return settleWith(input, registration.identity, subagentContext)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
      provision: (ensure) =>
        Effect.sync(() => {
          provisions.add(ensure)
        }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

/**
 * Appends `after` notes to a settlement.
 *
 * `result` and `output` have to move together: the model's view of a local tool result is
 * recomputed from the projected `{ structured, content }` pair, not from `result`, so annotating
 * one and not the other would show the renderer and the model different things.
 *
 * The empty-content case is why this is not a one-liner. `ToolOutput.toResultValue` reports a
 * tool with no content parts as `{ type: "json", value: structured }`; append a note to that and
 * it silently becomes a lone text part, and the structured payload disappears from context. So
 * when there is nothing to append to, the structured value is rendered as the leading text part
 * first -- annotating a result must never cost the model the result.
 */
function annotate(settlement: Settlement, notes: ReadonlyArray<string>): Settlement {
  if (settlement.result.type === "error") {
    return {
      ...settlement,
      result: { type: "error", value: `${settlement.result.value}\n\n${notes.join("\n\n")}` },
    }
  }
  const base = settlement.output ?? ToolOutput.fromResultValue(settlement.result) ?? { structured: {}, content: [] }
  const leading = base.content.length > 0 ? base.content : [{ type: "text" as const, text: stringify(base.structured) }]
  const output = {
    structured: base.structured,
    content: [...leading, ...notes.map((text) => ({ type: "text" as const, text }))],
  }
  return { ...settlement, result: ToolOutput.toResultValue(output), output }
}

function stringify(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolInterceptor.node, ToolOutputStore.node, ToolExecution.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolInterceptor.node, ToolOutputStore.node, ToolExecution.node],
})
