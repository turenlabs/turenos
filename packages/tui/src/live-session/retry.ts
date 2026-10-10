import type { LiveEvent } from "../live-events"
import { providerError } from "../messages"
import { isRecord } from "../response-validation"
import type { DashboardState } from "../state"

// Retries are keyed by server-chosen session IDs, so the map is bounded; the oldest entries go first.
const MAX_RETRIES = 256

// Events that show the turn moving again (or over), so a pending retry no longer describes it.
const progress =
  /^session\.next\.(prompted|step\.(started|ended|failed)|text\.started|reasoning\.started|tool\.(input\.started|called))$/

/**
 * Tracks `session.next.retried`: the server failed a provider request and waits before trying
 * again. Without it a retrying turn looks like an endless "Working". Returns whether it changed.
 */
export function trackRetry(state: DashboardState, event: LiveEvent) {
  const sessionID = event.data.sessionID
  if (typeof sessionID !== "string") return false
  if (event.type === "session.next.retried") {
    const attempt = event.data.attempt
    const delay = event.data.delay
    const error = isRecord(event.data.error) ? event.data.error : {}
    state.retries = {
      ...Object.fromEntries(
        Object.entries(state.retries)
          .filter(([id]) => id !== sessionID)
          .slice(-(MAX_RETRIES - 1)),
      ),
      [sessionID]: {
        attempt: typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
        at:
          Date.now() +
          (typeof delay === "number" && Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 3_600_000) : 0),
        message: providerError(typeof error.message === "string" ? error.message.slice(0, 2000) : "", error.statusCode),
      },
    }
    return true
  }
  if (!state.retries[sessionID] || !progress.test(event.type)) return false
  state.retries = Object.fromEntries(Object.entries(state.retries).filter(([id]) => id !== sessionID))
  return true
}
