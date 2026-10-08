import { mergeMessages } from "@turenlabs/client/team"
import { errorText } from "../server"
import { MAX_MESSAGES, PAGE, viewOf, type Answer, type TeamContext } from "./types"
import type { TeamStateOutput } from "@turenlabs/client"

/** The in-flight load; a request that arrives meanwhile runs once more afterwards. */
export type Loader = { ctx: TeamContext; running: Promise<void> | undefined; again: boolean; older: boolean }

export function newLoader(ctx: TeamContext): Loader {
  return { ctx, running: undefined, again: false, older: false }
}

/** Loads for the current selection without repainting; the dashboard's 2-second refresh calls this. */
export function load(loader: Loader) {
  if (loader.running) {
    loader.again = true
    return loader.running
  }
  loader.running = drain(loader).finally(() => {
    loader.running = undefined
  })
  return loader.running
}

/** Loads, repaints, and loads again when the repaint chose a different default room. */
export async function sync(loader: Loader) {
  const { state } = loader.ctx
  for (let attempt = 0; attempt < 2; attempt++) {
    await load(loader)
    if (state.closed || state.tab !== "team") return
    loader.ctx.repaint()
    const view = viewOf(state)
    if (view.error || !state.selected || view.room?.id === state.selected) return
  }
}

async function drain(loader: Loader) {
  const { state } = loader.ctx
  do {
    loader.again = false
    await once(loader)
  } while (loader.again && !state.closed && state.tab === "team")
}

async function once(loader: Loader) {
  const { state } = loader.ctx
  const view = viewOf(state)
  const wanted = state.selected || undefined
  try {
    if (view.room && (!wanted || view.room.id === wanted)) await advance(loader, view.room.id)
    else await open(loader, wanted)
    if (!state.closed) view.error = undefined
  } catch (error) {
    if (!state.closed) view.error = errorText(error)
  }
}

/** The answer still belongs to what the user is looking at. */
function current(loader: Loader, roomID: string | undefined) {
  const { state } = loader.ctx
  return !state.closed && state.tab === "team" && (!roomID || !state.selected || state.selected === roomID)
}

/** The response validator accepted this answer, so its numbers are finite (the generated type also allows "NaN" strings). */
export function checked(answer: TeamStateOutput) {
  return answer as unknown as Answer
}

function replace(view: ReturnType<typeof viewOf>, answer: Answer) {
  view.rooms = answer.rooms
  view.room = answer.room
  view.teammates = answer.teammates
  view.tasks = answer.tasks
  view.duties = answer.duties
  view.factoryRuns = answer.factoryRuns ?? []
}

/** A room not loaded yet: its log restarts at the latest page. */
async function open(loader: Loader, roomID: string | undefined) {
  const { state, connection } = loader.ctx
  const answer = checked(await connection.client.team.state({ roomID, limit: PAGE }))
  if (!current(loader, roomID)) return
  const view = viewOf(state)
  replace(view, answer)
  view.messages = answer.messages
  view.hasMore = answer.hasMore
  view.follow = true
}

/** Polling: messages after the highest loaded one, page after page, merged by id. */
async function advance(loader: Loader, roomID: string) {
  const { state, connection } = loader.ctx
  const view = viewOf(state)
  const after = view.messages.at(-1)?.seq
  let answer = checked(await connection.client.team.state({ roomID, after, limit: PAGE }))
  let received = answer.messages
  // A full page may be followed by more; the bound keeps one poll from running away.
  for (let pages = 0, page = answer; pages < 10; pages++) {
    if (after === undefined || page.messages.length < PAGE) break
    page = checked(await connection.client.team.state({ roomID, after: page.messages.at(-1)!.seq, limit: PAGE }))
    received = [...received, ...page.messages]
    answer = page
  }
  if (!current(loader, roomID) || view.room?.id !== roomID) return
  replace(view, answer)
  const merged = mergeMessages(view.messages, received)
  const trimmed = merged.length > MAX_MESSAGES
  view.messages = trimmed ? merged.slice(-MAX_MESSAGES) : merged
  view.hasMore = after === undefined ? answer.hasMore : view.hasMore || trimmed
}

/** Older messages: the page before the lowest loaded sequence number. */
export async function older(loader: Loader) {
  const { state, connection, say } = loader.ctx
  const view = viewOf(state)
  const roomID = view.room?.id
  const before = view.messages[0]?.seq
  if (state.tab !== "team" || !roomID || before === undefined || loader.older) return
  if (!view.hasMore) return say("Start of the room reached.")
  if (view.messages.length >= MAX_MESSAGES)
    return say(`Showing the latest ${MAX_MESSAGES} messages; older ones stay on the server.`)
  loader.older = true
  try {
    const answer = checked(await connection.client.team.state({ roomID, before, limit: PAGE }))
    if (!current(loader, roomID) || view.room?.id !== roomID) return
    view.messages = mergeMessages(answer.messages, view.messages)
    view.hasMore = answer.hasMore
    loader.ctx.repaint()
  } catch (error) {
    say(`Earlier messages unavailable: ${errorText(error)}`, true)
  } finally {
    loader.older = false
  }
}
