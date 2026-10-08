import { display } from "../messages"
import { checkDirectory, invalid, object, string } from "../response-validation"
import type { Context } from "./context"
import { errorText } from "./errors"
import { inputDirectory } from "./transport"

export class WorktreeNotStartedError extends Error {}

/**
 * The server records checkout/bootstrap completion by the original creation name.
 * Retries only read that outcome: missing history is uncertain, never permission
 * to create another worktree or infer readiness from files left on disk.
 */
export async function worktree(
  ctx: Pick<Context, "api" | "controller">,
  directory: string,
  name: string,
  retry: boolean,
  signal?: AbortSignal,
) {
  inputDirectory(directory)
  const expired = AbortSignal.timeout(5 * 60 * 1000)
  const stop = AbortSignal.any([ctx.controller.signal, expired, ...(signal ? [signal] : [])])
  const read = () =>
    ctx.api("/experimental/worktree/status", { directory, query: { name }, signal: stop }).then(outcome)
  try {
    let status = await read().catch((error) => {
      if (retry) throw error
      throw new WorktreeNotStartedError(
        `Worktree creation has not started. Check the connection and server readiness support: ${errorText(error)}`,
      )
    })
    if (retry && status.status === "unknown")
      throw new Error(
        "The server has no retained worktree outcome. Inspect the original attempt before starting another.",
      )
    if (!retry && status.status !== "unknown")
      throw new Error("This worktree name already has a recorded creation. Retry the original attempt.")
    const target = retry
      ? undefined
      : object(
          await ctx.api("/experimental/worktree", {
            method: "POST",
            directory,
            body: { name },
            timeout: 60000,
            signal: stop,
          }),
        ).directory
    if (target !== undefined) checkDirectory(target)
    if (!retry) status = await read()
    while (status.status === "pending") {
      stop.throwIfAborted()
      await Bun.sleep(250)
      stop.throwIfAborted()
      status = await read()
    }
    if (status.status === "unknown")
      throw new Error("The server lost the worktree outcome. Inspect the original attempt before starting another.")
    if (status.status === "ready" && target !== undefined && status.directory !== target)
      invalid("worktree directory identity")
    return status
  } catch (error) {
    if (expired.aborted) throw new Error("The server is still preparing the worktree. Ctrl+S keeps waiting.")
    throw error
  }
}

function outcome(value: unknown) {
  const item = object(value)
  if (item.status === "unknown") return { status: "unknown" as const }
  if (item.status === "pending") return { status: "pending" as const }
  if (item.status === "failed") return { status: "failed" as const, message: display(string(item.message), 500) }
  if (item.status !== "ready") invalid("worktree creation status")
  checkDirectory(item.directory)
  return { status: "ready" as const, directory: string(item.directory, 4096) }
}
