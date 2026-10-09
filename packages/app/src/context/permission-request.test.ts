import { describe, expect, test } from "bun:test"
import type { ForgeClient } from "@turenlabs/sdk/v2/client"
import { permissionFromV2, replyToPermission } from "./permission-request"

function recordingClient() {
  const calls: { route: string; input: unknown }[] = []
  const client = {
    permission: {
      respond: async (input: unknown) => {
        calls.push({ route: "legacy", input })
        return { data: true }
      },
    },
    v2: {
      session: {
        permission: {
          reply: async (input: unknown) => {
            calls.push({ route: "core", input })
            return { data: true }
          },
        },
      },
    },
  } as unknown as ForgeClient
  return { calls, client }
}

describe("replyToPermission", () => {
  test("answers a Session Core request on the Session Core route", async () => {
    const ctx = recordingClient()
    const request = permissionFromV2({ id: "per_2", sessionID: "ses_1", action: "read", resources: [".env"] })

    await replyToPermission(ctx.client, request, "always")

    expect(ctx.calls).toEqual([{ route: "core", input: { sessionID: "ses_1", requestID: "per_2", reply: "always" } }])
  })

  test("answers a legacy request on the legacy route", async () => {
    const ctx = recordingClient()
    const request = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: {}, always: [] }

    await replyToPermission(ctx.client, request, "reject")

    expect(ctx.calls).toEqual([
      { route: "legacy", input: { sessionID: "ses_1", permissionID: "per_1", response: "reject" } },
    ])
  })
})
