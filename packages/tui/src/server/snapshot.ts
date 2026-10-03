import { ClientError } from "@turenlabs/client"
import type { SessionsListOutput } from "@turenlabs/client"
import { identifier, isRecord } from "../response-validation"
import type { Client, Context } from "./context"
import { errorText } from "./errors"

type InventoryErrors = { terminals: string; automations: string }

export async function snapshot(ctx: Context) {
  const request = { signal: AbortSignal.timeout(10000) }
  const inventoryErrors: InventoryErrors = { terminals: "", automations: "" }
  let folderError: string | undefined
  const [location, recent, active, loops] = await Promise.all([
    ctx.client.location.get(
      { location: ctx.options.directory ? { directory: ctx.options.directory } : undefined },
      request,
    ),
    ctx.client.sessions.list({ limit: 100, order: "desc", archived: false }, request),
    ctx.client.sessions.active(request),
    ctx.client.loops.list(request).catch((error: unknown) => inventoryError(inventoryErrors, "automations", error)),
    ctx.folders.read().catch((error: unknown) => {
      folderError = errorText(error)
    }),
  ])
  const sessions = await recentAndActive(ctx.client, recent, active, request)
  // Terminals are location-scoped on the server; read the server location and open folders.
  const directories = [...new Set([location.directory, ...(ctx.folders.current() ?? [])])].slice(0, 8)
  const terminals = await Promise.all(
    directories.map((directory) => ctx.client.ptys.list({ location: { directory } }, request)),
  ).catch((error: unknown) => inventoryError(inventoryErrors, "terminals", error))
  const folderStatus: { workingFolders?: string[]; folderError?: string } = {
    workingFolders: ctx.folders.current(),
    folderError,
  }
  return {
    ...folderStatus,
    location,
    sessions: [...sessions.values()].sort(
      (a, b) =>
        Number(Object.hasOwn(active, b.id)) - Number(Object.hasOwn(active, a.id)) || b.time.updated - a.time.updated,
    ),
    active,
    terminals: [
      ...new Map(
        (terminals ?? []).flatMap((page) => page.data.map((pty) => [pty.id, { ...pty, location: page.location }])),
      ).values(),
    ],
    terminalsAvailable: terminals !== undefined,
    loops: loops ?? [],
    inventoryErrors,
    updated: Date.now(),
    more: !!recent.cursor.next,
  }
}

/** The recent page plus every active session, and a root session when the page holds none. */
async function recentAndActive(
  client: Client,
  recent: SessionsListOutput,
  active: Record<string, unknown>,
  request: { signal: AbortSignal },
) {
  const sessions = new Map(recent.data.map((session) => [session.id, session]))
  const missing = Object.keys(active).filter((id) => {
    if (sessions.has(id)) return false
    identifier(id, "ses_")
    return true
  })
  // Limit concurrent HTTP requests while retaining every active session,
  // including older sessions absent from the recent-history page.
  for (let offset = 0; offset < missing.length; offset += 8) {
    const found = await Promise.all(
      missing.slice(offset, offset + 8).map((sessionID) => client.sessions.get({ sessionID }, request)),
    )
    found.forEach((session) => sessions.set(session.id, session))
  }
  if (sessions.size && ![...sessions.values()].some((session) => !session.parentID)) {
    const roots = await client.sessions.list({ roots: true, archived: false, order: "desc", limit: 100 }, request)
    roots.data.filter((session) => !session.parentID).forEach((session) => sessions.set(session.id, session))
  }
  return sessions
}

function inventoryError(inventoryErrors: InventoryErrors, kind: keyof InventoryErrors, error: unknown) {
  const status =
    error instanceof ClientError && error.reason === "UnexpectedStatus" && isRecord(error.cause)
      ? error.cause.status
      : undefined
  if (status === 401 || status === 403 || (isRecord(error) && error._tag === "UnauthorizedError")) throw error
  if (kind !== "terminals" || status !== 404) inventoryErrors[kind] = errorText(error)
  return undefined
}
