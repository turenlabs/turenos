import { describe, expect, test } from "bun:test"
import { createForgeClient } from "@turenlabs/sdk/v2/client"
import { disconnectProvider } from "./use-provider-connection"

function clientFor(fetcher: (request: Request) => Promise<Response>) {
  return createForgeClient({
    baseUrl: "http://localhost:3000",
    fetch: Object.assign((input: RequestInfo | URL) => fetcher(input instanceof Request ? input : new Request(input)), {
      preconnect: () => {},
    }),
  })
}

describe("provider disconnect", () => {
  test.each(["openai", "anthropic", "xai", "custom-provider"])(
    "removes stored auth and invalidates runtime before completing for %s",
    async (providerID) => {
      const calls: string[] = []
      const client = clientFor(async (request) => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`)
        return Response.json(true)
      })
      await disconnectProvider({
        providerID,
        client,
        exclude: (id) => {
          calls.push(`exclude ${id}`)
        },
        refresh: async () => {
          calls.push("refresh")
        },
      })
      expect(calls).toEqual([`DELETE /auth/${providerID}`, `exclude ${providerID}`, "POST /global/dispose", "refresh"])
    },
  )

  test("does not report a local disconnect when credential deletion fails", async () => {
    const calls: string[] = []
    const client = clientFor(async () => Response.json({ message: "Removal failed" }, { status: 500 }))
    await expect(
      disconnectProvider({
        providerID: "anthropic",
        client,
        exclude: () => {
          calls.push("exclude")
        },
        refresh: async () => {
          calls.push("refresh")
        },
      }),
    ).rejects.toBeDefined()
    expect(calls).toEqual([])
  })

  test("refreshes stale picker state even when runtime disposal fails after deletion", async () => {
    const calls: string[] = []
    const client = clientFor(async (request) =>
      request.method === "DELETE" ? Response.json(true) : Response.json({ message: "Unavailable" }, { status: 503 }),
    )
    await expect(
      disconnectProvider({
        providerID: "xai",
        client,
        exclude: () => {
          calls.push("exclude")
        },
        refresh: async () => {
          calls.push("refresh")
        },
      }),
    ).rejects.toBeDefined()
    expect(calls).toEqual(["exclude", "refresh"])
  })
})
