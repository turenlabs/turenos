/**
 * Tuning constants for the Bramblewick service.
 *
 * These values are load-bearing for the token-efficiency benchmark: several
 * benchmark tasks assert on them by exact value, so do not change them without
 * also updating `src/tasks.ts`.
 */

export const SERVICE_NAME = "bramblewick"

/** Maximum number of times a failed tenant lookup is retried. */
export const MAX_RETRY_ATTEMPTS = 4271

/** Milliseconds before an in-flight request is abandoned. */
export const REQUEST_TIMEOUT_MS = 3000

/** Size of the in-process record cache, in entries. */
export const CACHE_CAPACITY = 512

export interface ServiceConfig {
  readonly name: string
  readonly maxRetryAttempts: number
  readonly requestTimeoutMs: number
  readonly cacheCapacity: number
}

export function defaultConfig(): ServiceConfig {
  return {
    name: SERVICE_NAME,
    maxRetryAttempts: MAX_RETRY_ATTEMPTS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    cacheCapacity: CACHE_CAPACITY,
  }
}
