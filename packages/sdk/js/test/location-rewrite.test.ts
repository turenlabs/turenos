import { describe, expect, test } from "bun:test"
import { createForgeClient } from "../src/v2/client"

function recorder() {
  const requests: Request[] = []
  const fetch = (async (request: Request) => {
    requests.push(request)
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

describe("location rewrite", () => {
  test("injects the configured directory into both query forms on /api requests", async () => {
    const { fetch, requests } = recorder()
    const client = createForgeClient({ baseUrl: "http://localhost:4096", directory: "/configured", fetch })

    await client.v2.question.request.list()

    const params = new URL(requests[0]!.url).searchParams
    expect(params.get("directory")).toBe("/configured")
    expect(params.get("location[directory]")).toBe("/configured")
    expect(requests[0]!.headers.get("x-forge-directory")).toBeNull()
  })

  test("keeps an explicit location[directory] instead of injecting a conflicting directory", async () => {
    const { fetch, requests } = recorder()
    const client = createForgeClient({ baseUrl: "http://localhost:4096", directory: "/configured", fetch })

    await client.v2.question.request.list({ location: { directory: "/explicit" } })

    const params = new URL(requests[0]!.url).searchParams
    expect(params.get("location[directory]")).toBe("/explicit")
    expect(params.get("directory")).toBe("/explicit")
  })

  test("keeps an explicit directory filter instead of injecting a conflicting location[directory]", async () => {
    const { fetch, requests } = recorder()
    const client = createForgeClient({ baseUrl: "http://localhost:4096", directory: "/configured", fetch })

    await client.v2.session.list({ directory: "/filtered" })

    const params = new URL(requests[0]!.url).searchParams
    expect(params.get("directory")).toBe("/filtered")
    expect(params.get("location[directory]")).toBe("/filtered")
  })

  test("keeps an explicit location[workspace] instead of injecting a conflicting workspace", async () => {
    const { fetch, requests } = recorder()
    const client = createForgeClient({
      baseUrl: "http://localhost:4096",
      directory: "/configured",
      experimental_workspaceID: "wrk_configured",
      fetch,
    })

    await client.v2.question.request.list({ location: { directory: "/explicit", workspace: "wrk_explicit" } })

    const params = new URL(requests[0]!.url).searchParams
    expect(params.get("location[workspace]")).toBe("wrk_explicit")
    expect(params.get("workspace")).toBe("wrk_explicit")
    expect(requests[0]!.headers.get("x-forge-workspace")).toBeNull()
  })

  test("injects only the plain directory on non-/api requests", async () => {
    const { fetch, requests } = recorder()
    const client = createForgeClient({ baseUrl: "http://localhost:4096", directory: "/configured", fetch })

    await client.path.get()

    const params = new URL(requests[0]!.url).searchParams
    expect(params.get("directory")).toBe("/configured")
    expect(params.get("location[directory]")).toBeNull()
  })

  test("an unscoped client leaves explicit location params alone", async () => {
    const { fetch, requests } = recorder()
    const client = createForgeClient({ baseUrl: "http://localhost:4096", fetch })

    await client.v2.question.request.list({ location: { directory: "/explicit" } })

    const params = new URL(requests[0]!.url).searchParams
    expect(params.get("location[directory]")).toBe("/explicit")
    expect(params.get("directory")).toBeNull()
  })
})
