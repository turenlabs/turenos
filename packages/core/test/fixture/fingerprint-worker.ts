import { Effect } from "effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { GitFingerprint } from "@turenlabs/core/git-fingerprint"

// Holds a capture open between its passes until killed, for crash-recovery tests.
const input = JSON.parse(process.argv[2]!) as { worktree: string; scratch: string }

await Effect.gen(function* () {
  const fingerprint = yield* GitFingerprint.Service
  yield* fingerprint.capture({
    repository: {
      worktree: input.worktree,
      gitDirectory: input.worktree + "/.git",
      commonDirectory: input.worktree + "/.git",
    },
    scratch: input.scratch,
    limits: { timeoutMs: 60_000 },
    between: Effect.never,
  })
}).pipe(Effect.provide(LayerNode.compile(GitFingerprint.node)), Effect.runPromise)
