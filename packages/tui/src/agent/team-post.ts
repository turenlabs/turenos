import { assignedHandles, mentionedHandles, roomCoordinator } from "@turenlabs/client/team"
import { handleOf } from "../team/format"
import type { Answer } from "../team/types"
import { emit, quote, type Run } from "./context"
import { messageText, newID, writeFailure } from "./delivery"
import { AgentError, usage } from "./errors"
import { takes } from "./options"
import { idArgument } from "./state"
import { roomState } from "./team-room"
import { taskText } from "./team-text"

const maxText = 20_000

export async function post(run: Run) {
  const names = takes("team post", run.positionals, ["room"], ["text"])
  const messageID = run.values.id !== undefined ? idArgument(run.values.id, "msg_", "--id") : newID("msg_")
  const text = await messageText(run, names[1])
  if (text.length > maxText) throw usage("Enter a message between 1 and 20,000 characters.")
  const state = await roomState(run, names[0], 1)
  const retry = `turen-tui team post ${quote(names[0]!)} --id ${messageID}${run.flags} <same text>`
  const posted = await run.connection.client.team
    .messagePost({ id: messageID, roomID: state.room.id, text })
    .catch((error: unknown) => {
      // The server stores a message by its ID and answers an exact retry with the stored one, so only a 4xx, or a 409
      // (an archived room, or an ID held for other text), means nothing was posted.
      const failure = writeFailure(error, { messageID }, retry, { noun: "message", nothing: "posted", conflict: true })
      if (!state.room.archived || failure.retry) throw failure
      throw new AgentError(`${failure.message} Restore it in the dashboard (4, then d).`)
    })
  const tasks = posted.tasks as typeof state.tasks
  const mentioned = mentionedHandles(text)
  const replies = mentioned.length ? undefined : roomCoordinator(state.room, state.teammates)
  const notes = mentioned.length ? missing(text, state, tasks) : []
  // The result stays on stdout; what a mention did not do is a note beside it.
  notes.filter((note) => note.stray).forEach((note) => run.io.stderr(`turen-tui: ${note.text}\n`))
  return emit(
    run,
    {
      ok: true,
      room: state.room.id,
      message: posted.message,
      tasks,
      ...(replies ? { coordinator: replies.handle } : {}),
    },
    [
      `posted ${posted.message.id}`,
      ...tasks.map((task) => taskText(task, state.teammates, run.flags)),
      ...(mentioned.length
        ? notes.filter((note) => !note.stray).map((note) => note.text)
        : [
            replies
              ? `no mention · @${replies.handle} (coordinator) replies`
              : "no mention · no active teammate will reply",
          ]),
    ].join("\n"),
  )
}

/** Mentions that created no task: a handle that is not in the room (`stray`), or a teammate who is paused. */
function missing(text: string, state: Answer, tasks: Answer["tasks"]) {
  const known = assignedHandles(text, state.teammates)
  const tasked = tasks.map((task) => handleOf(state.teammates, task.teammateID).slice(1).toLowerCase())
  return mentionedHandles(text)
    .filter((handle) => !tasked.includes(handle))
    .map((handle) =>
      known.includes(handle)
        ? { stray: false, text: `@${handle} is paused; no task was created` }
        : { stray: true, text: `@${handle} is not in this room; no task was created` },
    )
}
