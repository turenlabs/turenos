import { expect, test } from "bun:test"
import { fixture, cleanup } from "./model-connections-fixture"

const provider = { id: "antigravity-acp", name: "Antigravity ACP (local)" }
const url = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F&state=fixture"
const waiting = { id: "attempt-one", status: "waiting", url }

async function open(app: Awaited<ReturnType<typeof fixture>>) {
  app.open()
  await app.screen("Connect a provider")
  await app.view.mockInput.typeText("Antigravity")
  app.view.mockInput.pressEnter()
  await app.screen("Sign in with Google")
  app.view.mockInput.pressEnter()
}

test("ACP native login displays the browser URL, polls, verifies and refreshes", async () => {
  const app = await fixture({
    provider,
    route: (request) => {
      const path = new URL(request.url).pathname
      if (path === "/provider/antigravity-acp/auth") return Response.json(waiting)
      if (path === "/provider/antigravity-acp/auth/attempt-one")
        return Response.json({ id: waiting.id, status: "authenticated" })
      if (path === "/global/dispose") return Response.json(true)
    },
  })
  await open(app)
  expect(await app.screen("Open this Google sign-in URL")).toContain("accounts.google.com")
  await app.screen("Model picker")
  expect(app.notices.at(-1)?.message).toBe("Antigravity ACP signed in; native session verified.")
  const auth = app.requests.filter((request) => request.path.includes("/auth"))
  expect(auth.map((request) => request.method)).toEqual(["POST", "GET"])
  expect(auth.every((request) => request.directory === "/srv/original directory")).toBe(true)
  expect(app.requests.some((request) => request.path === "/global/dispose")).toBe(true)
})

test("ACP Escape cancels a late authorize response without aborting its ownership request", async () => {
  const authorization = Promise.withResolvers<Response>()
  const cancelled = Promise.withResolvers<void>()
  cleanup.push(() => authorization.resolve(Response.json(waiting)))
  const app = await fixture({
    provider,
    route: (request) => {
      if (request.method === "POST") return authorization.promise
      if (request.method === "DELETE") {
        cancelled.resolve()
        return Response.json({ id: waiting.id, status: "cancelled" })
      }
    },
  })
  await open(app)
  await app.screen("Starting the official")
  app.view.mockInput.pressEscape()
  await app.screen("Connect a provider")
  authorization.resolve(Response.json(waiting))
  await cancelled.promise
  expect(app.requests.filter((request) => request.method === "DELETE")).toMatchObject([
    { path: "/provider/antigravity-acp/auth/attempt-one", directory: "/srv/original directory" },
  ])
  expect(app.notices.some((notice) => notice.message.includes("signed in"))).toBe(false)
})

test("ACP cancel waits for confirmation and permits a retry", async () => {
  const cancellation = Promise.withResolvers<Response>()
  cleanup.push(() => cancellation.resolve(Response.json({ id: waiting.id, status: "cancelled" })))
  const app = await fixture({
    provider,
    route: (request) => {
      if (request.method === "DELETE") return cancellation.promise
      if (new URL(request.url).pathname.startsWith("/provider/antigravity-acp/auth")) return Response.json(waiting)
    },
  })
  await open(app)
  await app.screen("Open this Google sign-in URL")
  app.view.mockInput.pressKey("c")
  await app.screen("Cancelling sign-in on the server")
  app.view.mockInput.pressEnter()
  expect(app.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  cancellation.resolve(Response.json({ id: waiting.id, status: "cancelled" }))
  await app.screen("Sign-in cancelled")
  app.view.mockInput.pressEnter()
  await app.screen("Open this Google sign-in URL")
  expect(app.requests.filter((request) => request.method === "POST")).toHaveLength(2)
})

test("ACP errors remain visible without leaking raw HTTP failures or invalid authorization URLs", async () => {
  const app = await fixture({
    provider,
    route: (request) => {
      if (new URL(request.url).pathname === "/provider/antigravity-acp/auth")
        return Response.json({ ...waiting, url: "https://evil.example/secret" })
    },
  })
  await open(app)
  const frame = await app.screen("could not be confirmed")
  expect(frame).not.toContain("evil.example")
  expect(app.notices.some((notice) => notice.message.includes("signed in"))).toBe(false)
})
