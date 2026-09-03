import { describe, expect, test } from "bun:test"
import {
  assertConnectionPolicyOptions,
  connectionPolicyKey,
  ConnectionPolicyError,
  createConnectionPolicyFetch,
  createConnectionPolicyFetchForEndpoint,
  type ConnectionPolicy,
} from "@/provider/connection-policy"

const now = 1_800_000_000_000
const policy = {
  id: "qualified-provider",
  origin: "https://models.example",
  pathPrefix: "/coding/v1",
  pinnedAddresses: ["203.0.113.10"],
  expiresAt: now + 60_000,
} satisfies ConnectionPolicy

describe("provider connection policy", () => {
  test("binds cache identity to the qualified provider credential", () => {
    const first = { ...policy, credentialHash: "a".repeat(64) }
    const second = { ...policy, credentialHash: "b".repeat(64) }
    expect(connectionPolicyKey(first)).not.toBe(connectionPolicyKey(second))
    expect(() => connectionPolicyKey({ ...policy, credentialHash: "invalid" })).toThrow(
      "credential fingerprint is invalid",
    )
  })

  test("uses the pinned address for an exact origin and API path without redirects", async () => {
    const calls: Array<{ url: string; addresses: readonly string[]; redirect?: RequestRedirect }> = []
    const fetch = createConnectionPolicyFetch(policy, {
      now: () => now,
      resolve: async () => ["203.0.113.10"],
      request: async (url, init, addresses) => {
        calls.push({ url: url.href, addresses, redirect: init.redirect })
        return new Response("ok")
      },
    })

    expect(await (await fetch("https://models.example/coding/v1/messages")).text()).toBe("ok")
    expect(calls).toEqual([
      {
        url: "https://models.example/coding/v1/messages",
        addresses: ["203.0.113.10"],
        redirect: "manual",
      },
    ])
  })

  test("qualifies an endpoint before constructing its redirect-rejecting fetch", async () => {
    const calls: Array<{ url: string; addresses: readonly string[]; redirect?: RequestRedirect }> = []
    const fetch = await createConnectionPolicyFetchForEndpoint(
      {
        id: "qualified-endpoint",
        endpoint: "https://models.example/coding/v1",
      },
      {
        now: () => now,
        resolve: async () => ["203.0.113.10"],
        request: async (url, init, addresses) => {
          calls.push({ url: url.href, addresses, redirect: init.redirect })
          return new Response(null, { status: 302 })
        },
      },
    )

    await expect(fetch("https://models.example/coding/v1/messages")).rejects.toThrow(
      "Endpoint redirects are prohibited",
    )
    expect(calls).toEqual([
      {
        url: "https://models.example/coding/v1/messages",
        addresses: ["203.0.113.10"],
        redirect: "manual",
      },
    ])
  })

  test("fails closed when DNS drifts from the immutable pins", async () => {
    let requested = false
    const fetch = createConnectionPolicyFetch(policy, {
      now: () => now,
      resolve: async () => ["203.0.113.11"],
      request: async () => {
        requested = true
        return new Response()
      },
    })

    await expect(fetch("https://models.example/coding/v1/messages")).rejects.toThrow(
      "Endpoint DNS changed after qualification",
    )
    expect(requested).toBe(false)
  })

  test("keeps all currently qualified addresses in deterministic fallback order", async () => {
    let addresses: readonly string[] = []
    const fetch = createConnectionPolicyFetch(
      { ...policy, pinnedAddresses: ["203.0.113.12", "203.0.113.10"] },
      {
        now: () => now,
        resolve: async () => ["203.0.113.12", "203.0.113.10"],
        request: async (_url, _init, selected) => {
          addresses = selected
          return new Response()
        },
      },
    )

    await fetch("https://models.example/coding/v1/messages")
    expect(addresses).toEqual(["203.0.113.10", "203.0.113.12"])
  })

  test("rejects redirects, escaped paths, origins, and proxy overrides", async () => {
    const dependencies = {
      now: () => now,
      resolve: async () => ["203.0.113.10"],
      request: async () => new Response(null, { status: 307, headers: { location: "https://other.example" } }),
    }
    const fetch = createConnectionPolicyFetch(policy, dependencies)

    await expect(fetch("https://models.example/coding/v1/messages")).rejects.toThrow(
      "Endpoint redirects are prohibited",
    )
    await expect(fetch("https://models.example/other")).rejects.toThrow("Request escaped its qualified API path")
    await expect(fetch("https://other.example/coding/v1/messages")).rejects.toThrow(
      "Request escaped its qualified origin",
    )
    await expect(
      fetch("https://models.example/coding/v1/messages", { proxy: "http://proxy.example" } as RequestInit),
    ).rejects.toThrow("Request-level proxy or dispatcher overrides are prohibited")
    expect(() => assertConnectionPolicyOptions({ proxy: "http://proxy.example" })).toThrow(ConnectionPolicyError)
  })

  test("isolates cache identities for different immutable pins", () => {
    expect(connectionPolicyKey(policy)).not.toBe(connectionPolicyKey({ ...policy, pinnedAddresses: ["203.0.113.11"] }))
    expect(connectionPolicyKey(policy)).toBe(connectionPolicyKey({ ...policy }))
  })

  test("allows HTTP only for loopback origins and pins", () => {
    expect(() =>
      connectionPolicyKey({
        ...policy,
        origin: "http://models.example",
      }),
    ).toThrow("Remote connection policies require HTTPS")
    expect(() =>
      connectionPolicyKey({
        ...policy,
        origin: "http://127.0.0.1:11434",
        pathPrefix: "/api",
        pinnedAddresses: ["127.0.0.1"],
      }),
    ).not.toThrow()
  })

  test("retires a policy transport without allowing it to reopen", async () => {
    let closed = 0
    const fetch = createConnectionPolicyFetch(policy, {
      now: () => now,
      resolve: async () => ["203.0.113.10"],
      request: async () => new Response("ok"),
      close: () => {
        closed++
      },
    })

    expect(await (await fetch("https://models.example/coding/v1/messages")).text()).toBe("ok")
    fetch.close()
    expect(closed).toBe(1)
    await expect(fetch("https://models.example/coding/v1/messages")).rejects.toThrow(
      "Connection policy transport retired",
    )
  })
})
