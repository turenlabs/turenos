import { expect, test } from "bun:test"
import { createForgeClient } from "../src/v2/client"

test("predictions retain server authentication, directory, and cancellation", async () => {
  let recorded: Request | undefined
  const abort = new AbortController()
  const client = createForgeClient({
    baseUrl: "http://localhost:4096",
    directory: "/test directory",
    headers: { Authorization: "Basic test" },
    fetch: (async (request: Request) => {
      recorded = request
      return Response.json({ text: "run the tests" })
    }) as typeof fetch,
  })
  const result = await client.predictMessage("ses_example", abort.signal)
  expect(result.data.text).toBe("run the tests")
  expect(recorded!.method).toBe("POST")
  expect(new URL(recorded!.url).pathname).toBe("/session/ses_example/prediction")
  expect(recorded!.headers.get("Authorization")).toBe("Basic test")
  expect(recorded!.headers.get("x-forge-directory")).toBe(encodeURIComponent("/test directory"))
  abort.abort()
  expect(recorded!.signal.aborted).toBe(true)
})
