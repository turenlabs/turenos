import type { TeamFactoryRunGetOutput } from "@turenlabs/client"
import { handleOf } from "../team/format"
import { emit, type Run } from "./context"
import { whole, takes } from "./options"
import { requestsText } from "./requests"
import { idArgument, inBatches, pendingFor } from "./state"
import { roomState } from "./team-room"
import { runDetail, runLine, taskText } from "./team-text"
import { defaultTimeout, patiently, poll } from "./wait"

/** Blocks until a factory run leaves `running`: exit 0 succeeded, 3 needs input, 5 failed, cancelled or stale, 4 timeout. */
export async function waitRun(run: Run) {
  const runID = idArgument(takes("team wait", run.positionals, ["run-id"])[0], "", "The run ID")
  const timeout = whole("timeout", run.values.timeout, defaultTimeout, 0, 31_536_000)
  const look = () => run.connection.client.team.factoryRunGet({ runID })
  // Like `wait`, the first lookup is tried again while the server is down; an unknown run fails at once.
  const first = await patiently(timeout, look)
  const settled =
    first.status !== "running"
      ? first
      : await poll(
          run.connection,
          timeout,
          () => look().then((latest) => (latest.status === "running" ? undefined : latest)),
          `Factory run ${runID} was deleted while waiting.`,
        )
  if (!settled)
    return emit(
      run,
      { run: runID, status: "timeout" },
      `run ${runID} · timeout (still running after ${timeout}s; run turen-tui team wait ${runID}${run.flags} to keep waiting)`,
      4,
    )
  if (settled.status === "needs_input") return needsInput(run, settled)
  const done = settled.status === "succeeded"
  return emit(run, { run: settled }, [runLine("run", settled), ...runDetail(settled)].join("\n"), done ? 0 : 5)
}

/** The run's task sessions, each with the requests that wait on it and the commands that resolve them. */
async function needsInput(run: Run, settled: TeamFactoryRunGetOutput) {
  const state = await roomState(run, settled.roomID, 1)
  const tasks = state.tasks.filter((task) => task.factoryRunID === settled.id || settled.taskIDs.includes(task.id))
  const pending = await inBatches(tasks, 8, (task) => pendingFor(run.connection, task.sessionID))
  return emit(
    run,
    {
      run: settled,
      tasks: tasks.map((task, index) => ({
        ...task,
        handle: handleOf(state.teammates, task.teammateID),
        pending: pending[index],
      })),
    },
    [
      runLine("run", settled),
      ...tasks.flatMap((task, index) => [
        taskText(task, state.teammates, run.flags),
        ...[requestsText(pending[index]!, run.flags)].filter(Boolean),
      ]),
    ].join("\n"),
    3,
  )
}
