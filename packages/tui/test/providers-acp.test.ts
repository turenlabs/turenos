import { expect, test } from "bun:test"
import { fixture } from "./providers-fixture"

const state = { id: "attempt-one", status: "starting" as const }

test("ACP requests keep the owning directory and use native routes for cancellation", async () => {
  const calls: { path: string; method: string; directory: string | null }[] = []
  const app = fixture((request) => {
    const url = new URL(request.url)
    calls.push({ path: url.pathname, method: request.method, directory: url.searchParams.get("directory") })
    return Response.json(state)
  })
  expect(await app.providers.acp.authorize("/test/project")).toEqual(state)
  await app.providers.acp.status("/test/project", state.id, new AbortController().signal)
  await app.providers.acp.cancel("/test/project", state.id)
  expect(calls).toEqual([
    { path: "/provider/antigravity-acp/auth", method: "POST", directory: "/test/project" },
    { path: "/provider/antigravity-acp/auth/attempt-one", method: "GET", directory: "/test/project" },
    { path: "/provider/antigravity-acp/auth/attempt-one", method: "DELETE", directory: "/test/project" },
  ])
})

test("ACP completion clears only its provider opt-out before refreshing", async () => {
  const writes: unknown[] = []
  const app = fixture(async (request) => {
    if (request.method === "GET") return Response.json({ disabled_providers: ["other", "antigravity-acp"] })
    writes.push({ path: new URL(request.url).pathname, body: request.body ? await request.json() : undefined })
    return Response.json(true)
  })
  await app.providers.acp.complete()
  expect(writes).toEqual([
    { path: "/global/config", body: { disabled_providers: ["other"] } },
    { path: "/global/dispose", body: undefined },
  ])
})

test("ACP rejects malformed state and never exposes HTTP error bodies", async () => {
  for (const response of [
    Response.json({ id: "attempt-one", status: "unexpected" }),
    Response.json({ id: "../escape", status: "starting" }),
    Response.json({ id: "attempt-one", status: "error", message: "unsafe\u001b[31m" }),
    new Response("secret-error-body", { status: 500 }),
  ]) {
    const app = fixture(() => response)
    await expect(app.providers.acp.authorize("/test/project")).rejects.toThrow()
  }
  const app = fixture(() => new Response("secret-error-body", { status: 500 }))
  await expect(app.providers.acp.authorize("/test/project")).rejects.not.toThrow("secret-error-body")
})
