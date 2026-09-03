import { describe, expect, test } from "bun:test"
import { httpStatus, isPermanentHttpError, retry } from "@turenlabs/core/util/retry"

const wrapped = (message: string, status: number) => new Error(message, { cause: { body: {}, status } })

const counted = (fail: number, error: unknown) => {
  let attempts = 0
  return {
    attempts: () => attempts,
    run: async () => {
      attempts += 1
      if (attempts <= fail) throw error
      return "ok"
    },
  }
}

describe("retry", () => {
  test("does not retry a permanent 404 even when it looks transient", async () => {
    // The V2 adoption 404 is a deliberate, permanent answer. Repeating it turns
    // one dead endpoint into a request storm.
    const adopted = wrapped("Legacy transcript is unavailable after Session V2 adoption: ses_1", 404)
    const call = counted(Infinity, adopted)

    await expect(retry(call.run, { delay: 1 })).rejects.toThrow("Legacy transcript is unavailable")
    expect(call.attempts()).toBe(1)

    // A 4xx body whose text matches the transient list must not buy a retry.
    const decoy = counted(Infinity, wrapped("failed to fetch the thing", 400))
    await expect(retry(decoy.run, { delay: 1 })).rejects.toThrow("failed to fetch")
    expect(decoy.attempts()).toBe(1)
  })

  test("still retries transient network failures that carry no status", async () => {
    const call = counted(2, new TypeError("Failed to fetch"))
    expect(await retry(call.run, { delay: 1 })).toBe("ok")
    expect(call.attempts()).toBe(3)
  })

  test("still retries 5xx and the statuses that invite a later attempt", async () => {
    for (const status of [500, 502, 503, 408, 425, 429]) {
      const call = counted(1, wrapped("load failed", status))
      expect(await retry(call.run, { delay: 1 })).toBe("ok")
      expect(call.attempts()).toBe(2)
    }
  })

  test("reads a status from cause, the error itself, or a response", () => {
    expect(httpStatus(wrapped("x", 404))).toBe(404)
    expect(httpStatus({ status: 403 })).toBe(403)
    expect(httpStatus({ response: { status: 401 } })).toBe(401)
    expect(httpStatus(new Error("network error (no response)"))).toBeUndefined()
    expect(isPermanentHttpError(new Error("load failed"))).toBe(false)
    expect(isPermanentHttpError(wrapped("x", 404))).toBe(true)
    expect(isPermanentHttpError(wrapped("x", 429))).toBe(false)
    expect(isPermanentHttpError(wrapped("x", 500))).toBe(false)
  })
})
