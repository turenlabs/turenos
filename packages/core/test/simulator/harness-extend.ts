/**
 * Simulator harness extensions for missing lifecycle gaps:
 * - Caller cancellation vs. session interruption
 * - Explicit message IDs for idempotency testing
 * - Retry exhaustion scenarios
 * - Concurrent session orchestration
 *
 * These are added as internal harness utilities so existing scenarios remain isolated.
 */

import type { Effect } from "effect"
import type { SessionMessage } from "@turenlabs/core/session/message"
import type { SessionSchema } from "@turenlabs/core/session/schema"

/**
 * Caller cancellation simulates an HTTP client disconnect or timeout while waiting for
 * a session operation (prompt, resume) to complete. Unlike explicit interrupt, caller
 * cancellation should NOT stop the process-owned session drain — the drain continues
 * and completes normally, but the caller's wait is cancelled.
 *
 * Implemented as a background fiber that cancels the caller after a delay, leaving the
 * session owner to run uninterrupted. The settled assertions prove the session continues
 * to completion despite the caller being cancelled.
 */
export type CallerCancellation = {
  readonly type: "caller-cancel"
  readonly delay: number // milliseconds before caller is cancelled
  readonly operationName: string // "prompt" | "resume" | "answer"
}

/**
 * Explicit message ID support for idempotency testing. Allows scenarios to retry
 * the exact same message with the same ID to verify:
 * - Same-ID exact retry returns the existing row
 * - Conflicting reuse (different delivery/text/model) is rejected
 * - Concurrent exact admissions de-duplicate
 * - Replayed prompts survive session interruption
 */
export interface PromptWithID {
  readonly text: string
  readonly messageID?: SessionMessage.ID
  readonly delivery?: "steer" | "queue"
  readonly resume?: boolean
}

/**
 * Explicit attempt control for retry exhaustion testing. Injects a series of
 * retryable failures and tracks how many times the session retries before
 * either succeeding or exhausting the retry budget (8 attempts).
 */
export interface RetrySequence {
  readonly retryable: Array<{ readonly delay: number }>
  readonly finalOutcome: "success" | "failure"
}

/**
 * Distributed scenario control for testing coordinator concurrency, multiple
 * independent root sessions, and race conditions between drain ownership and
 * concurrent callers.
 */
export interface ConcurrentScenarioContext {
  readonly sessionIDs: SessionSchema.ID[]
  readonly coordinator: {
    readonly claimAll: () => Effect.Effect<void>
    readonly releaseOne: (sessionID: SessionSchema.ID) => Effect.Effect<void>
    readonly promoteInOrder: () => Effect.Effect<void>
  }
}
