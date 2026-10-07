import { ClientError } from "@turenlabs/client"
import type { SessionsListOutput } from "@turenlabs/client"
import { identifier, isRecord } from "../response-validation"
import { ACTIVE_OMITTED } from "../response-validation/session-routes"
import type { Client, Context } from "./context"
import { errorText, httpStatus } from "./errors"

type InventoryErrors = { terminals: string; automations: string }

export async function snapshot(ctx: Context) {
  // One deadline per request: the rounds below run in sequence, so a shared one expires on a slow link.
  const request = () => ({ signal: AbortSignal.timeout(10000) })
  const inventoryErrors: InventoryErrors = { terminals: "", automations: "" }
  let folderError: string | undefined
  const [location, recent, reported, loops] = await Promise.all([
    ctx.client.location.get(
      { location: ctx.options.directory ? { directory: ctx.options.directory } : undefined },
      request(),
    ),
    ctx.client.sessions.list({ limit: 100, order: "desc", archived: false }, request()),
    ctx.client.sessions.active(request()),
    ctx.client.loops.list(request()).catch((error: unknown) => inventoryError(inventoryErrors, "automations", error)),
    ctx.folders.read().catch((error: unknown) => {
      folderError = errorText(error)
    }),
  ])
  const omitted = Number(reported[ACTIVE_OMITTED] ?? 0)
  const active = Object.fromEntries(Object.entries(reported).filter(([id]) => id !== ACTIVE_OMITTED))
  const sessions = await recentAndActive(ctx.client, recent, active, request)
  const needsInput = omitted > 0 ? [] : await waitingOnInput(ctx.client, Object.keys(active).slice(0, 8), request)
  // Terminals are location-scoped on the server; read the server location and open folders.
  const directories = [...new Set([location.directory, ...(ctx.folders.current() ?? [])])].slice(0, 8)
  const pages = await Promise.all(
    directories.map((directory) =>
      ctx.client.ptys
        .list({ location: { directory } }, request())
        .catch((error: unknown) => inventoryError(inventoryErrors, "terminals", error)),
    ),
  )
  const terminals = pages.filter((page) => page !== undefined)
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
    // Running sessions with a pending permission or question: the active map says only `running`.
    ...(needsInput.length ? { needsInput } : {}),
    // Set only when the server reported more running sessions than the client tracks.
    ...(omitted > 0 ? { activeOmitted: omitted } : {}),
    terminals: [
      ...new Map(
        terminals.flatMap((page) => page.data.map((pty) => [pty.id, { ...pty, location: page.location }])),
      ).values(),
    ],
    terminalsAvailable: terminals.length > 0,
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
  request: () => { signal: AbortSignal },
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
      missing.slice(offset, offset + 8).map((sessionID) =>
        client.sessions.get({ sessionID }, request()).catch((error: unknown) => {
          // A session deleted between the active read and this fetch must not fail the whole snapshot.
          if (httpStatus(error) === 404) return undefined
          throw error
        }),
      ),
    )
    found.forEach((session) => session && sessions.set(session.id, session))
  }
  if (sessions.size && ![...sessions.values()].some((session) => !session.parentID)) {
    const roots = await client.sessions.list({ roots: true, archived: false, order: "desc", limit: 100 }, request())
    roots.data.filter((session) => !session.parentID).forEach((session) => sessions.set(session.id, session))
  }
  return sessions
}

/** At most four sessions at a time, so no more than eight requests are in flight; a failed read means no mark. */
async function waitingOnInput(client: Client, running: string[], request: () => { signal: AbortSignal }) {
  const waiting: string[] = []
  for (let offset = 0; offset < running.length; offset += 4) {
    const chunk = running.slice(offset, offset + 4)
    const pending = await Promise.all(
      chunk.map((sessionID) =>
        Promise.all([
          client.permissions.list({ sessionID }, request()).catch(() => []),
          client.questions.list({ sessionID }, request()).catch(() => []),
        ]),
      ),
    )
    waiting.push(...chunk.filter((_, index) => pending[index]!.some((list) => list.length > 0)))
  }
  return waiting
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
