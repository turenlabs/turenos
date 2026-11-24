import type { Session } from "@turenlabs/sdk/v2"

type Candidate = Pick<Session, "id" | "parentID" | "title" | "time">

export function latestTaskSessionID(
  sessions: readonly Candidate[] | undefined,
  parentID: string,
  description: string,
  agent: string | undefined,
) {
  const mention = agent ? `@${agent}` : undefined
  let latest: Candidate | undefined
  for (const session of sessions ?? []) {
    if (session.parentID !== parentID || session.time?.archived) continue
    if (description && !session.title.startsWith(description)) continue
    if (mention && !session.title.includes(mention)) continue
    if (!latest || (session.time.created ?? 0) > (latest.time.created ?? 0)) latest = session
  }
  return latest?.id
}
