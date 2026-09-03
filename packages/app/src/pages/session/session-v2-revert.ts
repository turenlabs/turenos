import type { RevertState } from "@turenlabs/sdk/v2/client"
import type { DirectorySDK } from "@/context/sdk"

export async function stageSessionV2Revert(
  client: DirectorySDK["client"],
  input: { sessionID: string; messageID: string },
) {
  await client.v2.session.interrupt({ sessionID: input.sessionID })
  const response = await client.v2.session.revert.stage({
    sessionID: input.sessionID,
    sessionRevertStagePayload: { messageID: input.messageID },
  })
  const revert = response.data?.data
  if (!revert) throw new Error("TurenOS did not return the staged revert")
  return revert
}

export async function clearSessionV2Revert(client: DirectorySDK["client"], sessionID: string) {
  await client.v2.session.interrupt({ sessionID })
  await client.v2.session.revert.clear({ sessionID })
}

export function applySessionV2Revert<T extends object>(
  session: T,
  revert: RevertState | undefined,
): Omit<T, "revert"> & { revert: RevertState | undefined } {
  return { ...session, revert }
}
