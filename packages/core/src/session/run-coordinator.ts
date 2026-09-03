export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

export interface ExecutionControl<Key> {
  readonly active: Effect.Effect<ReadonlySet<Key>>
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Wakes advisory work only after the caller's busy checks allow it. */
  readonly wakeAdvisory?: (key: Key) => Effect.Effect<void>
  /** Schedules local follow-up work without forcing a provider turn. */
  readonly retry?: (key: Key) => Effect.Effect<void>
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> extends ExecutionControl<Key> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Atomically claims execution and returns a separately interruptible join handle. */
  readonly claim: (key: Key) => Effect.Effect<Effect.Effect<void, E>>
  /** Atomically claims a pending-work drain without forcing a provider turn. */
  readonly claimPending: (key: Key) => Effect.Effect<Effect.Effect<void, E>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Registers one coalesced follow-up that must run a provider turn even without pending input. */
  readonly wakeForced: (key: Key, forceIfIdle?: boolean) => Effect.Effect<void>
  /** Wakes advisory work only after the caller's busy checks allow it. */
  readonly wakeAdvisory?: (key: Key) => Effect.Effect<void>
  /** Schedules local follow-up work without forcing a provider turn. */
  readonly retry?: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  pendingForce: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean, control: ExecutionControl<Key>) => Effect.Effect<void, E>
  readonly wakeAdvisory?: (key: Key) => Effect.Effect<void>
  readonly retry?: (key: Key) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      pendingForce: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready).pipe(Effect.andThen(Effect.yieldNow))).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force, executionControl()))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        const force = entry.pendingForce
        entry.pendingForce = false
        start(key, entry, force, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        // A forced adoption turn is only valid after the current drain settled normally. A
        // provider/tool failure must not be converted into an automatic retry just because a
        // Harness snapshot changed while it was running.
        successor.pendingForce = Exit.isSuccess(exit) && entry.pendingForce
        active.set(key, successor)
        start(key, successor, successor.pendingForce, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const claimWith = (key: Key, force: boolean): Effect.Effect<Effect.Effect<void, E>> =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return Deferred.await(entry.done).pipe(Effect.andThen(run(key)))
          return Deferred.await(entry.done)
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, force)
        return Deferred.await(next.done)
      })

    const claim = (key: Key) => claimWith(key, true)
    const claimPending = (key: Key) => claimWith(key, false)

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => claim(key).pipe(Effect.flatMap(restore)))

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const wakeForced = (key: Key, forceIfIdle = true) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          entry.pendingForce = true
          return
        }

        if (!forceIfIdle) return

        const next = makeEntry()
        active.set(key, next)
        start(key, next, forceIfIdle)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    function executionControl(): ExecutionControl<Key> {
      return {
        active: Effect.sync(() => new Set(active.keys())),
        wake,
        wakeAdvisory: options.wakeAdvisory,
        retry: options.retry,
        interrupt,
      }
    }

    return {
      active: Effect.sync(() => new Set(active.keys())),
      claim,
      claimPending,
      run,
      wake,
      wakeForced,
      wakeAdvisory: options.wakeAdvisory,
      retry: options.retry,
      interrupt,
    }
  })
