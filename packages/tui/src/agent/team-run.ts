import { httpStatus } from "../server"
import { clean, emit, quote, type Run } from "./context"
import { writeFailure } from "./delivery"
import { AgentError, usage } from "./errors"
import { takes } from "./options"
import { idArgument } from "./state"
import { roomState } from "./team-room"
import { runDetail, runGone, runLine } from "./team-text"

const maxRequest = 4000

export async function startRun(run: Run) {
  const names = takes("team run", run.positionals, ["room"], ["request"])
  const runID = run.values.id !== undefined ? idArgument(run.values.id, "", "--id") : crypto.randomUUID()
  const request = await requestText(run, names[1])
  const state = await roomState(run, names[0], 1)
  if (!state.room.factory)
    throw new AgentError(
      `Room ${clean(state.room.name, 120)} has no factory. Configure it in the dashboard (4, then F).`,
    )
  const retry = `turen-tui team run ${quote(names[0]!)} --id ${runID}${run.flags} <same request>`
  const started = await run.connection.client.team
    .factoryRun({ roomID: state.room.id, id: runID, ...(request ? { request } : {}) })
    .catch((error: unknown) => {
      // The server keeps a run by its ID and answers an exact retry with the stored run.
      const failure = writeFailure(error, { messageID: runID }, retry, {
        noun: "run",
        nothing: "started",
        conflict: true,
      })
      const active = state.factoryRuns?.find((item) => item.status === "running")
      if (!active || httpStatus(error) !== 409) throw failure
      throw new AgentError(
        `${failure.message} Active run: ${active.id}. Wait with: turen-tui team wait ${active.id}${run.flags}`,
      )
    })
  return emit(
    run,
    { ok: true, run: started },
    [runLine("started", started), `  wait: turen-tui team wait ${started.id}${run.flags}`].join("\n"),
  )
}

export async function cancelRun(run: Run) {
  const runID = idArgument(takes("team cancel", run.positionals, ["run-id"])[0], "", "The run ID")
  const client = run.connection.client.team
  const current = await client.factoryRunGet({ runID }).catch(runGone(run.flags))
  // The server leaves a finished run as it is, so the answer would read as a cancellation that did not happen.
  if (["succeeded", "failed", "cancelled", "stale"].includes(current.status))
    return emit(run, { ok: true, run: current }, `run ${runID} already ${current.status}; nothing to cancel.`)
  const cancelled = await client.factoryRunCancel({ runID })
  return emit(run, { ok: true, run: cancelled }, [runLine("run", cancelled), ...runDetail(cancelled)].join("\n"))
}

/** The optional request: the argument, or stdin for `-`. */
async function requestText(run: Run, given: string | undefined) {
  if (given === "-" && run.io.stdin.tty) throw usage("Pipe the request on stdin, or give it as an argument.")
  const text = given === "-" ? (await run.io.stdin.read()).replace(/\s+$/, "") : given
  if (text && text.length > maxRequest) throw usage("The request is at most 4,000 characters.")
  return text || undefined
}
