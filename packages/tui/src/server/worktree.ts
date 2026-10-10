import { display } from "../messages"
import { array, checkDirectory, invalid, object, string } from "../response-validation"
import type { Context } from "./context"
import { errorText } from "./errors"
import { inputDirectory } from "./transport"

export class WorktreeNotStartedError extends Error {}

/**
 * The server records checkout/bootstrap completion by the original creation name.
 * A retry reads that outcome and never infers readiness from files left on disk.
 * With no record it sends the create again under the same retained name, so a first
 * POST that never landed is simply made now. A worktree already listed under that
 * name means the first POST did land and the server forgot it (a restart); forge
 * would then fall back to a suffixed name and orphan it, so the retry stops instead.
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
    if (!retry && status.status !== "unknown")
      throw new Error("This worktree name already has a recorded creation. Retry the original attempt.")
    const create = status.status === "unknown"
    const orphan = create && retry ? await existingWorktree(ctx, directory, name, stop) : undefined
    if (orphan !== undefined)
      throw new Error(
        `Worktree ${name} exists at ${display(orphan, 500)} but the server lost its setup outcome. Remove it or start the session there yourself.`,
      )
    const target = !create
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
    if (create) status = await read()
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

/** The listed worktree directory whose last path segment is `name`. */
async function existingWorktree(ctx: Pick<Context, "api">, directory: string, name: string, signal: AbortSignal) {
  return array(await ctx.api("/experimental/worktree", { directory, signal }), 10000).find(
    (item): item is string => typeof item === "string" && item.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) === name,
  )
}
