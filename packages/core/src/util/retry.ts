export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
]

// 4xx answers are the server stating a fact about the request, not a hiccup:
// repeating the same request cannot change the verdict. The exceptions are the
// three statuses that explicitly invite a later attempt.
const RETRYABLE_CLIENT_STATUS = new Set([408, 425, 429])

function isTransientError(error: unknown): boolean {
  if (!error) return false
  // oxlint-disable-next-line no-base-to-string -- error is unknown, intentional coercion for message matching
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => message.includes(m))
}

/**
 * Best-effort HTTP status for an error thrown by a generated client. The SDK
 * error interceptor stores `{ body, status }` under `cause`; other shapes
 * (raw responses, fetch-style errors) expose `status` directly. Anything we
 * cannot read stays `undefined`, which keeps the existing retry behaviour —
 * notably network failures, which have no status at all.
 */
export function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return
  const candidates: unknown[] = [
    error,
    (error as { cause?: unknown }).cause,
    (error as { response?: unknown }).response,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const status = (candidate as { status?: unknown }).status
    if (typeof status === "number" && Number.isFinite(status)) return status
  }
}

export function isPermanentHttpError(error: unknown): boolean {
  const status = httpStatus(error)
  if (status === undefined) return false
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUS.has(status)
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delay = 500, factor = 2, maxDelay = 10000, retryIf = isTransientError } = options

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      // A permanent 4xx short-circuits ahead of `retryIf` so a transient-looking
      // message ("failed to fetch this", "load failed") in a deliberate 404/403
      // body cannot buy the request another round trip. 5xx and status-less
      // network errors are untouched and still retry.
      if (attempt === attempts - 1 || isPermanentHttpError(error) || !retryIf(error)) throw error
      const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}
