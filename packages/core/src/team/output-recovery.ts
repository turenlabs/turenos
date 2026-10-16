export * as TeamOutputRecovery from "./output-recovery"

import { sql } from "drizzle-orm"

export type Candidate = { readonly id: string; readonly seq: number; readonly taskID: string | null }

/** Select identities, not transcript bodies. Durable publication is the recovery checkpoint. */
export function candidates(input: { sessionID: string; after?: number; limit: number; now: number }) {
  return sql`
    select message.id, message.seq, (
      select case when task.status in ('succeeded', 'failed', 'stale')
        or (task.status = 'running' and task.lease_expires_at <= ${input.now})
        then task.id end
      from team_task task
      join session_message prompt on prompt.id = 'msg_team_' || task.id
        and prompt.session_id = task.session_id and prompt.type = 'user'
      where task.session_id = message.session_id and prompt.seq < message.seq
      order by prompt.seq desc limit 1
    ) as taskID
    from session_message message
    where message.session_id = ${input.sessionID} and message.type = 'assistant'
      ${input.after === undefined ? sql`` : sql`and message.seq > ${input.after}`}
      and not exists (
        select 1 from team_message published
        where published.session_id = message.session_id
          and published.source_key = 'session-output:' || message.session_id || ':' || message.id
      )
      and not exists (
        select 1 from team_message published
        where published.session_id = message.session_id and published.source_key like 'task:%'
          and exists (select 1 from json_each(published.source_message_ids) source where source.value = message.id)
      )
      and json_extract(message.data, '$.time.completed') is not null
      and json_extract(message.data, '$.finish') = 'stop'
      and json_extract(message.data, '$.error') is null
    order by message.seq asc limit ${input.limit}
  `
}
