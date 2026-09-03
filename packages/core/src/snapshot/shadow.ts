export * as SnapshotShadow from "./shadow"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { Storage } from "../storage"
import { Hash } from "../util/hash"

const scope = Storage.Scope.make("internal/snapshot-worktree")
const bindings = 1000

export interface Input {
  /** Global data directory the `snapshot` tree lives under. */
  readonly data: string
  readonly projectID: string
  /** Checkout the shadow repository mirrors, exactly as the caller derives it. */
  readonly worktree: string
}

/**
 * Resolve the shadow Git repository directory for a worktree. Both the v1 and
 * v2 snapshot implementations go through here so they keep addressing the same
 * on-disk repository for the same checkout.
 */
export const directory = Effect.fnUntraced(function* (input: Input) {
  const storage = yield* Storage.Service
  const prefix = `${input.projectID}/`
  const bound = yield* storage.query({ scope, prefix, limit: bindings })
  const held = bound.find((state) => state.value === input.worktree)?.key.slice(prefix.length)
  // The checkout path is not ours: people move and rename directories, and a
  // symlinked parent can resolve to a different string between runs. Snapshot
  // ids are persisted on sessions forever, so a binding we already hold always
  // wins, and a binding whose checkout no longer exists is that same worktree
  // seen at its new path -- rebinding it keeps every stored id pointing at the
  // repository that still holds its trees instead of stranding them in an
  // abandoned directory. The path may only *seed* a worktree we have never
  // bound, and the seed is claimed immediately so the next move has a binding
  // to find. Seeding from the derivation used before the binding existed is
  // what keeps already-installed worktrees on their current repository.
  const binding = held ?? (yield* orphan(bound, prefix)) ?? Hash.fast(input.worktree)
  if (!held) yield* storage.set({ scope, key: Storage.Key.make(prefix + binding), value: input.worktree })
  return path.join(input.data, "snapshot", input.projectID, binding)
})

const orphan = Effect.fnUntraced(function* (bound: ReadonlyArray<Storage.State>, prefix: string) {
  const fs = yield* FSUtil.Service
  for (const state of bound) {
    if (yield* fs.existsSafe(state.value)) continue
    return state.key.slice(prefix.length)
  }
  return undefined
})
