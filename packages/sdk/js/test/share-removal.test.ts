import { describe, expect, test } from "bun:test"

import { createForgeClient } from "../src/client"
import { createForgeClient as createForgeClientV2 } from "../src/v2/client"

describe("session publishing contract", () => {
  test("legacy client exposes revoke but not publish", () => {
    const clients = [
      createForgeClient({ baseUrl: "http://localhost" }),
      createForgeClientV2({ baseUrl: "http://localhost" }),
    ]

    for (const client of clients) {
      const session = client.session as unknown as Record<string, unknown>
      expect(typeof session.unshare).toBe("function")
      expect(session).not.toHaveProperty("share")
    }
  })

  test("committed OpenAPI has DELETE-only legacy cleanup and no share URL field", async () => {
    const document = (await Bun.file(new URL("../../openapi.json", import.meta.url)).json()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
    }
    const route = document.paths["/session/{sessionID}/share"]
    const session = document.components.schemas.Session?.properties ?? {}

    expect(Object.keys(route ?? {})).toEqual(["delete"])
    expect(session).toHaveProperty("shared")
    expect(session).not.toHaveProperty("share")
  })
})
