import { type Run } from "./context"
import { checked } from "../team/load"
import { isRecord } from "../response-validation"
import { AgentError, usage } from "./errors"
import { sequence, whole } from "./options"
import { roomState } from "./team-room"
import { defaultTimeout, patiently, poll } from "./wait"

/**
 * The page of a room that `team show` reads: the newest `limit` messages, or with `--after` the next ones, or with
 * `--before` the ones just before a sequence number. `--wait` holds an `--after` read until a message arrives; the
 * result then carries `timedOut` (the seconds waited) when none did. The timeout and poll rules are `wait`'s.
 */
export async function readPage(run: Run, given: string | undefined, limit: number) {
  const after = sequence("after", run.values.after)
  const before = sequence("before", run.values.before)
  if (after !== undefined && before !== undefined) throw usage("--after and --before cannot be used together.")
  if (run.values.wait && after === undefined) throw usage("--wait needs --after <seq>.")
  if (run.values.timeout !== undefined && !run.values.wait) throw usage("--timeout needs --wait.")
  const cursor = { after, before }
  if (!run.values.wait) return { state: await roomState(run, given, limit, cursor) }
  const timeout = whole("timeout", run.values.timeout, defaultTimeout, 0, 31_536_000)
  const first = await patiently(timeout, () => roomState(run, given, limit, cursor))
  if (first.messages.length) return { state: first }
  // The room already existed. Keep missing-item errors intact so poll reports deletion, not an old server.
  const found = await poll(
    run.connection,
    timeout,
    () =>
      run.connection.client.team
        .state({ roomID: first.room.id, limit, ...cursor })
        .catch((error: unknown) => {
          if (isRecord(error) && error._tag === "InvalidRequestError" && error.kind === "Team.NotFoundError")
            throw new AgentError(`Room ${first.room.id} was deleted while waiting.`)
          throw error
        })
        .then(checked)
        .then((latest) => (latest.messages.length ? latest : undefined)),
    `Room ${first.room.id} was deleted while waiting.`,
  )
  return found ? { state: found } : { state: first, timedOut: timeout }
}
