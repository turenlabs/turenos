export * as ToolInterceptor from "./interceptor"

import { Cause, Clock, Context, Effect, Layer, Option, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import type { State } from "../state"

/**
 * Scoped observation of the one tool settlement boundary.
 *
 * V2 has no hook bus and no `trigger` dispatcher: a plugin capability is a scoped registration
 * held by the service that owns the concern, run by that service at its own boundary. `AISDK`
 * does this for provider construction; this does it for tool execution. `ToolRegistry` owns the
 * single place a call resolves, so it is the only caller of `runBefore`/`runAfter`.
 *
 * Registrations are Location scoped, exactly like the plugins that create them, so a Session and
 * every subagent Session it spawns share one set -- child Sessions inherit the parent Location.
 *
 * ## Failure policy
 *
 * An interceptor that throws, dies, or runs long is treated as having no opinion: the call
 * proceeds with whatever the previous interceptors decided, and the cause is logged. A plugin
 * cannot both crash and block; a veto has to be stated. The alternative -- deny on error -- lets
 * one buggy plugin disable every tool in the Session, and matches neither V1's fail-open Batou
 * nor the surrounding ecosystem's advisory-hook convention.
 *
 * Interruption is never swallowed: if the turn is interrupted while an interceptor is running,
 * the interrupt propagates and settlement dies with it.
 */

export type Decision =
  | { readonly type: "deny"; readonly reason: string }
  | { readonly type: "replace"; readonly input: unknown }

export interface Identity {
  readonly sessionID: string
  readonly agent: string
  readonly assistantMessageID: string
  readonly callID: string
  readonly tool: string
}

export interface BeforeEvent extends Identity {
  readonly input: unknown
  decision?: Decision
}

export interface Result {
  readonly type: "json" | "text" | "error" | "content"
  readonly value: unknown
}

export interface AfterEvent extends Identity {
  readonly input: unknown
  readonly result: Result
  readonly denied: boolean
  readonly notes: string[]
}

export type FinalizeEvent = Identity
export type TurnEvent = Pick<Identity, "sessionID" | "assistantMessageID">

export type Callback<Event> = (event: Event) => Effect.Effect<void> | void

export type Outcome =
  | { readonly type: "allow"; readonly input: unknown }
  | { readonly type: "deny"; readonly reason: string }

export interface Interface {
  readonly hook: {
    readonly before: (callback: Callback<BeforeEvent>) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly after: (callback: Callback<AfterEvent>) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly finalize: (callback: Callback<FinalizeEvent>) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly turnComplete: (callback: Callback<TurnEvent>) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runBefore: (input: Identity & { readonly input: unknown }) => Effect.Effect<Outcome>
  readonly runAfter: (input: Omit<AfterEvent, "notes">) => Effect.Effect<ReadonlyArray<string>>
  readonly runFinally: (input: FinalizeEvent) => Effect.Effect<void>
  readonly runTurnComplete: (input: TurnEvent) => Effect.Effect<void>
  readonly awaitTurnComplete: (input: TurnEvent) => Effect.Effect<void>
}

/**
 * Whole-phase budgets, not per-interceptor ones: N slow plugins must not multiply into N times
 * the wait. Each interceptor gets whatever is left, so a turn can be delayed by at most the
 * budget for each phase of each tool call regardless of how many plugins are loaded.
 *
 * `before` is deliberately the larger of the two. It gates a decision the caller acts on, and a
 * real scanner (Batou self-limits at 15s) has to be able to finish inside it. `after` only
 * annotates a result the model is already going to see, so it stays short.
 */
const BEFORE_BUDGET_MS = 30_000
const AFTER_BUDGET_MS = 30_000

/** Interceptor-supplied strings reach the model, so they are bounded like any other input. */
const MAX_REASON_LENGTH = 2_000
const MAX_NOTES = 8
const MAX_NOTE_LENGTH = 4_000

const clamp = (value: string, limit: number) => (value.length <= limit ? value : `${value.slice(0, limit)}…`)

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ToolInterceptor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let beforeHooks: Callback<BeforeEvent>[] = []
    let afterHooks: Callback<AfterEvent>[] = []
    let finalizeHooks: Callback<FinalizeEvent>[] = []
    let turnHooks: Callback<TurnEvent>[] = []
    const completedTurns = new Set<string>()
    const turnWaiters = new Map<string, Set<() => void>>()
    const turnKey = (input: TurnEvent) => `${input.sessionID}:${input.assistantMessageID}`

    const register = <Event>(hooks: () => Callback<Event>[], update: (next: Callback<Event>[]) => void) =>
      Effect.fn("ToolInterceptor.hook")(function* (callback: Callback<Event>) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    /**
     * Runs one interceptor within `remaining` milliseconds. Reports whether it got to finish;
     * a timeout, a synchronous throw, and a defect are all "no opinion".
     *
     * `Effect.suspend` is what makes a synchronous `throw` inside a non-Effect callback a defect
     * of *this* effect rather than of the settlement fiber calling it.
     */
    const guard = (phase: string, tool: string, remaining: number, run: () => Effect.Effect<void> | void) =>
      Effect.suspend(() => {
        const result = run()
        return Effect.isEffect(result) ? result : Effect.void
      }).pipe(
        Effect.timeoutOption(remaining),
        Effect.map(Option.isSome),
        Effect.tap((finished) =>
          finished ? Effect.void : Effect.logWarning("tool interceptor timed out", { phase, tool }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("tool interceptor failed", { phase, tool, cause }).pipe(Effect.as(false)),
        ),
      )

    const runBefore = Effect.fn("ToolInterceptor.before")(function* (input: Identity & { readonly input: unknown }) {
      if (beforeHooks.length === 0) return { type: "allow", input: input.input } as const
      const deadline = (yield* Clock.currentTimeMillis) + BEFORE_BUDGET_MS
      let effective = input.input
      for (const hook of beforeHooks) {
        const remaining = deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) {
          yield* Effect.logWarning("tool interceptor budget exhausted", { phase: "execute.before", tool: input.tool })
          break
        }
        // A fresh event per interceptor: `decision` must describe what *this* one decided, never
        // an earlier one's answer read back a second time.
        const event: BeforeEvent = {
          sessionID: input.sessionID,
          agent: input.agent,
          assistantMessageID: input.assistantMessageID,
          callID: input.callID,
          tool: input.tool,
          input: effective,
        }
        yield* guard("execute.before", input.tool, remaining, () => hook(event))
        const decision = event.decision
        if (!decision) continue
        // Deny is terminal and monotone. Later interceptors are not consulted, so a security veto
        // cannot be reversed by whatever plugin happens to load after it.
        if (decision.type === "deny")
          return { type: "deny", reason: clamp(decision.reason, MAX_REASON_LENGTH) } as const
        effective = decision.input
      }
      return { type: "allow", input: effective } as const
    })

    const runAfter = Effect.fn("ToolInterceptor.after")(function* (input: Omit<AfterEvent, "notes">) {
      if (afterHooks.length === 0) return [] as ReadonlyArray<string>
      const deadline = (yield* Clock.currentTimeMillis) + AFTER_BUDGET_MS
      const collected: string[] = []
      for (const hook of afterHooks) {
        const remaining = deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) {
          yield* Effect.logWarning("tool interceptor budget exhausted", { phase: "execute.after", tool: input.tool })
          break
        }
        const notes: string[] = []
        const event: AfterEvent = { ...input, notes }
        yield* guard("execute.after", input.tool, remaining, () => hook(event))
        // Each interceptor owns its own array, so one cannot drop another's notes.
        for (const note of notes) {
          if (collected.length >= MAX_NOTES) break
          if (typeof note !== "string" || note.length === 0) continue
          collected.push(clamp(note, MAX_NOTE_LENGTH))
        }
      }
      return collected as ReadonlyArray<string>
    })

    const runFinally = Effect.fn("ToolInterceptor.finalize")(function* (input: FinalizeEvent) {
      if (finalizeHooks.length === 0) return
      const deadline = (yield* Clock.currentTimeMillis) + AFTER_BUDGET_MS
      for (const hook of finalizeHooks) {
        const remaining = deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) {
          yield* Effect.logWarning("tool interceptor budget exhausted", {
            phase: "execute.finalize",
            tool: input.tool,
          })
          break
        }
        yield* guard("execute.finalize", input.tool, remaining, () => hook(input))
      }
    })

    const runTurnComplete = Effect.fn("ToolInterceptor.turnComplete")(function* (input: TurnEvent) {
      const key = turnKey(input)
      completedTurns.add(key)
      turnWaiters.get(key)?.forEach((resolve) => resolve())
      turnWaiters.delete(key)
      if (turnHooks.length === 0) return
      const deadline = (yield* Clock.currentTimeMillis) + AFTER_BUDGET_MS
      for (const hook of turnHooks) {
        const remaining = deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) break
        yield* guard("execute.turnComplete", "provider-turn", remaining, () => hook(input))
      }
    })

    const awaitTurnComplete = Effect.fn("ToolInterceptor.awaitTurnComplete")((input: TurnEvent) => {
      if (turnHooks.length === 0 || completedTurns.has(turnKey(input))) return Effect.void
      return Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const key = turnKey(input)
            const waiters = turnWaiters.get(key) ?? new Set<() => void>()
            waiters.add(resolve)
            turnWaiters.set(key, waiters)
          }),
      )
    })

    return Service.of({
      hook: {
        before: register(
          () => beforeHooks,
          (next) => (beforeHooks = next),
        ),
        after: register(
          () => afterHooks,
          (next) => (afterHooks = next),
        ),
        finalize: register(
          () => finalizeHooks,
          (next) => (finalizeHooks = next),
        ),
        turnComplete: register(
          () => turnHooks,
          (next) => (turnHooks = next),
        ),
      },
      runBefore,
      runAfter,
      runFinally,
      runTurnComplete,
      awaitTurnComplete,
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })
