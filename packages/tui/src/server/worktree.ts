import { parseJSON } from "../api"
import { display } from "../messages"
import { array, checkDirectory, isRecord, object, string } from "../response-validation"
import { eventStream } from "../live-events"
import type { Context } from "./context"
import { inputDirectory } from "./transport"

/**
 * A new git worktree of `directory`, checked out and ready for a session. The server creates it,
 * checks it out in the background, then announces worktree.ready or worktree.failed on
 * /global/event, so that stream is open before the request that starts the checkout. `name` stays
 * the same across retries: after an uncertain attempt, the worktree it made is found and reused.
 * `signal` stops the requests and the event wait at once; the server keeps preparing what it started.
 */
export async function worktree(ctx: Context, directory: string, name: string, retry: boolean, signal?: AbortSignal) {
  inputDirectory(directory)
  const stop = new AbortController()
  const expired = AbortSignal.timeout(5 * 60 * 1000)
  const events = eventStream(
    ctx.url,
    "/global/event",
    ctx.headers,
    AbortSignal.any([ctx.controller.signal, stop.signal, expired, ...(signal ? [signal] : [])]),
  )[Symbol.asyncIterator]()
  try {
    // The first event, server.connected, means the server already forwards this worktree's events.
    await events.next()
    const found = retry ? await existingWorktree(ctx, directory, name, signal) : undefined
    // A worktree is checked out once it holds more than its `.git` link file.
    if (
      found &&
      array(await ctx.api("/file", { directory: found, query: { path: "" }, signal }), 20000).some(
        (item) => isRecord(item) && item.name !== ".git",
      )
    )
      return { status: "ready" as const, directory: found }
    const target =
      found ??
      string(
        object(
          await ctx.api("/experimental/worktree", {
            method: "POST",
            directory,
            body: { name },
            timeout: 60000,
            signal,
          }),
        ).directory,
        4096,
      )
    checkDirectory(target)
    for (let next = await events.next(); !next.done; next = await events.next()) {
      const outcome = worktreeOutcome(next.value, target)
      if (outcome) return outcome
    }
    throw new Error("The server stopped reporting before the worktree was ready.")
  } catch (error) {
    if (expired.aborted) throw new Error("The server is still preparing the worktree. Ctrl+S keeps waiting.")
    throw error
  } finally {
    stop.abort()
    void events.return?.()
  }
}

async function existingWorktree(ctx: Context, directory: string, name: string, signal?: AbortSignal) {
  return array(await ctx.api("/experimental/worktree", { directory, signal }), 10000).find(
    (item): item is string =>
      typeof item === "string" &&
      item
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1) === name,
  )
}

/** What one /global/event frame says about the worktree at `directory`, if anything. */
function worktreeOutcome(data: string, directory: string) {
  const event = parseJSON(data)
  if (!isRecord(event) || event.directory !== directory || !isRecord(event.payload)) return undefined
  if (event.payload.type === "worktree.ready") return { status: "ready" as const, directory }
  if (event.payload.type !== "worktree.failed") return undefined
  const message = isRecord(event.payload.properties) ? event.payload.properties.message : undefined
  return { status: "failed" as const, message: typeof message === "string" ? display(message, 500) : "" }
}
