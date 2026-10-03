import { ClientError } from "@turenlabs/client"
import { display } from "../messages"
import { isRecord } from "../response-validation"

export function errorText(error: unknown): string {
  if (error instanceof ClientError) {
    if (error.reason === "Transport") return `Connection failed: ${errorText(error.cause)}`
    if (error.reason === "UnexpectedStatus") {
      const status = isRecord(error.cause) ? error.cause.status : undefined
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)
        return "Server returned an unexpected HTTP response. Check the server logs."
      if (status === 401 || status === 403) return "Authentication required. Check the server credentials."
      if (status >= 500) return `Server returned HTTP ${status}. Retry; if it persists, check the server logs.`
      if (status === 404) return "Server returned HTTP 404. Check the server URL, requested item, and API version."
      return `Server returned HTTP ${status}. Check the request and server logs.`
    }
  }
  if (isRecord(error) && error._tag === "UnauthorizedError") {
    if (typeof error.message === "string" && error.message) return display(error.message, 500)
    return "Authentication required. Check the server credentials."
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return display(error.message, 500)
  }
  return "Request failed. Check the server connection."
}

/** The HTTP status behind a client failure, from a bare status or from the tagged body the generated client throws. */
export function httpStatus(error: unknown): number | undefined {
  if (error instanceof ClientError)
    return error.reason === "UnexpectedStatus" && isRecord(error.cause) && typeof error.cause.status === "number"
      ? error.cause.status
      : undefined
  if (!isRecord(error) || typeof error._tag !== "string") return undefined
  if (error._tag === "UnauthorizedError") return 401
  if (error._tag === "ConflictError" || error._tag.endsWith("ConflictError")) return 409
  if (error._tag.endsWith("NotFoundError")) return 404
  if (error._tag === "InvalidRequestError" || error._tag === "InvalidCursorError") return 400
  return undefined
}

/**
 * True when the server definitely refused a request (4xx other than 408 and 409), so nothing was
 * admitted. Transport failures, timeouts, 5xx and 409 are ambiguous: the request may have landed.
 */
export function refused(error: unknown) {
  const status = httpStatus(error)
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409
}
