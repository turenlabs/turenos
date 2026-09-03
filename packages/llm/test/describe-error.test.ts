import { describe, expect, test } from "bun:test"
import { describeError } from "../src/protocols/shared"

describe("describeError", () => {
  test("recovers the reason a decode failed", () => {
    // Effect formats a decode failure as `${reason} error (${info})` whenever it
    // carries no description, so "Decode error (200 POST …)" reaches the user
    // with the status and URL intact and the actual reason discarded. The cause
    // is where that reason lives.
    const decode = Object.assign(new Error("Decode error (200 POST https://provider.test/responses)"), {
      cause: new Error("Unexpected token < in JSON at position 0"),
    })

    expect(describeError(decode)).toBe(
      "Decode error (200 POST https://provider.test/responses): Unexpected token < in JSON at position 0",
    )
  })

  test("carries an errno up from a network failure", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    })

    expect(describeError(fetchFailed)).toBe("fetch failed: read ECONNRESET: ECONNRESET")
  })

  test("does not stutter when a wrapper repeats its cause", () => {
    const wrapper = Object.assign(new Error("boom"), { cause: new Error("boom") })

    expect(describeError(wrapper)).toBe("boom")
  })

  test("terminates on a self-referential chain", () => {
    const loop: { message: string; cause?: unknown } = new Error("looped")
    loop.cause = loop

    expect(describeError(loop)).toBe("looped")
  })

  test("falls back rather than returning an empty string", () => {
    expect(describeError(undefined)).toBe("unknown error")
    expect(describeError({})).toBe("unknown error")
  })
})
