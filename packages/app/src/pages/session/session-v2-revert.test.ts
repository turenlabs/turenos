import { describe, expect, test } from "bun:test"
import type { DirectorySDK } from "@/context/sdk"
import { applySessionV2Revert, clearSessionV2Revert, stageSessionV2Revert } from "./session-v2-revert"

describe("Session V2 revert mutations", () => {
  test("interrupts V2 execution before staging and requires the durable state response", async () => {
    const calls: string[] = []
    const revert = { messageID: "msg_boundary", snapshot: "snapshot" }
    const client = {
      v2: {
        session: {
          interrupt: async () => {
            calls.push("interrupt")
          },
          revert: {
            stage: async () => {
              calls.push("stage")
              return { data: { data: revert } }
            },
          },
        },
      },
    } as unknown as DirectorySDK["client"]

    expect(await stageSessionV2Revert(client, { sessionID: "ses_revert", messageID: "msg_boundary" })).toEqual(revert)
    expect(calls).toEqual(["interrupt", "stage"])
  })

  test("interrupts before clearing and updates only the local revert projection", async () => {
    const calls: string[] = []
    const client = {
      v2: {
        session: {
          interrupt: async () => {
            calls.push("interrupt")
          },
          revert: {
            clear: async () => {
              calls.push("clear")
            },
          },
        },
      },
    } as unknown as DirectorySDK["client"]

    await clearSessionV2Revert(client, "ses_revert")

    expect(calls).toEqual(["interrupt", "clear"])
    expect(applySessionV2Revert({ id: "ses_revert", revert: { messageID: "msg_boundary" } }, undefined)).toEqual({
      id: "ses_revert",
      revert: undefined,
    })
  })

  test("fails closed when staging succeeds without a state payload", async () => {
    const client = {
      v2: {
        session: {
          interrupt: async () => undefined,
          revert: {
            stage: async () => ({ data: undefined }),
          },
        },
      },
    } as unknown as DirectorySDK["client"]

    await expect(stageSessionV2Revert(client, { sessionID: "ses_revert", messageID: "msg_boundary" })).rejects.toThrow(
      "did not return",
    )
  })
})
