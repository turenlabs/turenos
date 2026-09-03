import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { ServerScope } from "@/utils/server-scope"
import { localLoopServer } from "./local-server"

const remote = {
  type: "http",
  http: { url: "https://remote.example" },
} as const satisfies ServerConnection.Any
const sidecar = {
  type: "sidecar",
  variant: "base",
  http: { url: "http://127.0.0.1:4096" },
} as const satisfies ServerConnection.Any

describe("localLoopServer", () => {
  test("selects the canonical local server even when a remote server is first", () => {
    expect(
      localLoopServer([remote, sidecar], (key) =>
        key === ServerConnection.key(sidecar) ? ServerScope.local : (String(key) as ServerScope),
      ),
    ).toBe(sidecar)
  })

  test("does not silently fall back to an active remote server", () => {
    expect(localLoopServer([remote], (key) => String(key) as ServerScope)).toBeUndefined()
  })
})
