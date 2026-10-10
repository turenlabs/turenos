import { expect, test } from "bun:test"
import { createApi } from "../src/api"
import { connect } from "../src/server"
import { modelRef, validateResponse } from "../src/response-validation"
import { session } from "./server-fixture"

test("connection sends server auth and refuses credential redirects", async () => {
  let redirected = false
  const authorization: (string | null)[] = []
  const target = Bun.serve({
    port: 0,
    fetch: () => {
      redirected = true
      return Response.json({ healthy: true })
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      authorization.push(request.headers.get("authorization"))
      return Response.redirect(target.url.href)
    },
  })
  const connection = connect({ url: server.url.href, username: "operator", password: "test-only-password" })
  try {
    await expect(connection.client.health.get()).rejects.toThrow()
    expect(authorization[0]).toBe(`Basic ${Buffer.from("operator:test-only-password").toString("base64")}`)
    expect(redirected).toBe(false)
  } finally {
    connection.close()
    await Promise.all([server.stop(true), target.stop(true)])
  }
  expect(() => connect({ url: "https://user:password@example.com" })).toThrow()
  expect(() => connect({ url: "https://example.com/another-server" })).toThrow("without a path prefix")
})

test("direct connections require HTTPS for credentials outside canonical numeric loopback", () => {
  for (const url of [
    "http://example.com:4096/",
    "http://192.168.1.10:4096/",
    "http://localhost:4096/",
    "http://127.0.0.1.example.com:4096/",
    "http://127.0.0.2:4096/",
    "http://0.0.0.0:4096/",
    "http://[::]:4096/",
    "http://[2001:db8::1]:4096/",
  ]) {
    expect(() => connect({ url, password: "test-only-password" })).toThrow(
      "Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.",
    )
    for (const password of [undefined, ""]) {
      expect(() => connect({ url, password }).close()).not.toThrow()
    }
  }
})

test("direct connections accept credentials over HTTPS and canonical numeric loopback HTTP", () => {
  for (const url of [
    "https://example.com:4096/",
    "https://192.168.1.10:4096/",
    "https://localhost:4096/",
    "http://127.0.0.1:4096/",
    "http://127.0.0.1:9000/",
    "http://[::1]:9000/",
  ]) {
    expect(() => connect({ url, password: "test-only-password" }).close()).not.toThrow()
  }
})

for (const local of [true, false]) {
  test(
    local ? "loopback auth bypasses inherited proxies" : "unauthenticated remote HTTP retains configured proxies",
    async () => {
      const direct: (string | null)[] = []
      const proxied: (string | null)[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          direct.push(request.headers.get("authorization"))
          return Response.json({ healthy: true, version: "test" })
        },
      })
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          proxied.push(request.headers.get("authorization"))
          return Response.json({ healthy: true, version: "test" })
        },
      })
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `import { connect } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
          const connection = connect({ url: process.env.TUI_TEST_URL, password: ${JSON.stringify(local ? "proxy-test-only" : "")} });
          try { await connection.client.health.get(); } finally { connection.close(); }`,
          ],
          {
            env: {
              ...process.env,
              TUI_TEST_URL: local ? server.url.href : "http://example.invalid",
              HTTP_PROXY: proxy.url.href,
              HTTPS_PROXY: proxy.url.href,
              ALL_PROXY: proxy.url.href,
              http_proxy: proxy.url.href,
              https_proxy: proxy.url.href,
              all_proxy: proxy.url.href,
              NO_PROXY: "",
              no_proxy: "",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 15000,
          },
        )
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect(stderr).toBe("")
        expect(code).toBe(0)
        const authorization = `Basic ${Buffer.from("forge:proxy-test-only").toString("base64")}`
        expect(direct).toEqual(local ? [authorization] : [])
        expect(proxied).toEqual(local ? [] : [null])
      } finally {
        await Promise.all([server.stop(true), proxy.stop(true)])
      }
    },
  )
}

test("oversized responses fail before JSON decoding and close cancels requests", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  })
  const connection = connect({ url: server.url.href })
  try {
    await expect(connection.client.health.get()).rejects.toMatchObject({
      reason: "Transport",
      cause: { message: "Server response exceeds the 8 MiB TUI limit." },
    })
    connection.close()
    await expect(connection.client.health.get()).rejects.toMatchObject({ reason: "Transport" })
  } finally {
    connection.close()
    await server.stop(true)
  }
})

test("ambiguous prompt failure can be retried with stable session and message IDs", async () => {
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      posts.push({ path, body })
      if (path === "/api/session") return Response.json({ data: session(String(body.id)) })
      if (posts.length === 2) return new Response("Upstream disconnected", { status: 502 })
      return Response.json({ data: { id: body.id, sessionID: path.split("/")[3] } })
    },
  })
  const connection = connect({ url: server.url.href })
  try {
    const launch = connection.launch()
    const input = { directory: "/srv/project", prompt: "Review the project", agent: "build" }
    expect(launch.sessionID).toMatch(/^ses_/)
    expect(launch.input()).toBeUndefined()
    await expect(launch(input)).rejects.toThrow()
    expect(posts[0]?.body.id).toBe(launch.sessionID)
    expect(launch.input()).toEqual(input)
    const saved = launch.input()!
    saved.prompt = "changed copy"
    expect(launch.input()).toEqual(input)
    await expect(launch({ ...input, prompt: "changed task" })).rejects.toThrow("original fields")
    await launch(input)
    expect(posts).toHaveLength(3)
    expect(posts[1]?.path).toBe(posts[2]?.path)
    expect(posts[1]?.body.id).toBe(posts[2]?.body.id)
    expect(posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
  } finally {
    connection.close()
    await server.stop(true)
  }
})

test("modelRef rejects invalid variant characters and types", () => {
  expect(() => modelRef({ id: "claude-sonnet-4", providerID: "anthropic", variant: "\u001b[31m" })).toThrow("name")
  expect(() => modelRef({ id: "claude-sonnet-4", providerID: "anthropic", variant: 123 })).toThrow("text")
})

test("session listing validation accepts sessions with empty model variant", () => {
  const sessionWithEmptyVariant = {
    ...session("ses_variant_test"),
    model: { id: "Union Alpha", providerID: "local", variant: "" },
  }
  expect(() =>
    validateResponse(new URL("https://example.test/api/session?limit=100"), undefined, {
      data: [sessionWithEmptyVariant],
      cursor: {},
    }),
  ).not.toThrow()
})

test("raw API credentials need HTTPS or loopback, and a discarded body is never read", async () => {
  const controller = new AbortController()
  const remote = createApi({
    url: new URL("http://example.invalid/"),
    headers: new Headers(),
    signal: controller.signal,
  })
  await expect(remote("/extension/x", { method: "PATCH", body: {}, secret: true })).rejects.toThrow("require HTTPS")
  let pulled = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            pulled += 65536
            stream.enqueue(new Uint8Array(65536).fill(32))
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  })
  try {
    const api = createApi({ url: new URL(server.url.origin), headers: new Headers(), signal: controller.signal })
    expect(await api("/global/config", { method: "PATCH", body: { agent: {} }, discard: true })).toBeUndefined()
    expect(pulled).toBeLessThan(8 * 1024 * 1024)
    await expect(api("/global/config", { method: "PATCH", body: { agent: {} } })).rejects.toThrow("8 MiB")
  } finally {
    controller.abort()
    await server.stop(true)
  }
})

test("a 401 or 403 is reported as one even when the server pads its body past the limit", async () => {
  const controller = new AbortController()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response(new Uint8Array(9 * 1024 * 1024), { status: request.method === "GET" ? 401 : 403 }),
  })
  try {
    const api = createApi({ url: new URL(server.url.origin), headers: new Headers(), signal: controller.signal })
    for (const method of ["GET", "POST"] as const)
      await expect(api("/api/session", { method })).rejects.toThrow("Authentication required")
  } finally {
    controller.abort()
    await server.stop(true)
  }
})
