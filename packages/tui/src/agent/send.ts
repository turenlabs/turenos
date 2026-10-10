import type { Session } from "../server"
import { promptPayload } from "../prompt-files"
import { clean, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { checkOutside, finish, messageText, newID, retryCommand, writeFailure } from "./delivery"
import { takes, whole } from "./options"
import { defaultTimeout } from "./wait"
import { startSession } from "./start"
import { getSession, idArgument, latestMessages } from "./state"

const newOnly = ["dir", "model", "variant", "agent", "session-id"] as const

export async function send(run: Run) {
  const timeout = whole("timeout", run.values.timeout, defaultTimeout, 0, 31_536_000)
  if (run.values.new) return startSession(run, timeout)
  if (newOnly.some((name) => run.values[name] !== undefined))
    throw usage("--dir, --model, --variant, --agent and --session-id apply only with --new.")
  const names = takes("send", run.positionals, ["session"], ["text"])
  const sessionID = idArgument(names[0], "ses_", "The session")
  const messageID = run.values.id !== undefined ? idArgument(run.values.id, "msg_", "--id") : newID("msg_")
  const text = await messageText(run, names[1])
  const delivery = run.values.queue ? "queue" : "steer"
  const session = await getSession(run.connection, sessionID)
  await refuseOwned(run, session)
  const request = await route(run, session, text, messageID, delivery)
  const baseline = run.values.wait ? (await latestMessages(run.connection, sessionID, 1)).at(-1)?.id : undefined
  await request().catch((error: unknown) => {
    throw (
      owned(session, error) ??
      writeFailure(error, { sessionID, messageID }, retryCommand(run, ` ${sessionID} --id ${messageID}`))
    )
  })
  return finish(run, { sessionID, messageID, delivery, created: false, timeout, baseline })
}

/** Decides, as the dashboard's reply does, whether the text is a shell command, a slash command or a prompt. */
async function route(run: Run, session: Session, text: string, messageID: string, delivery: "steer" | "queue") {
  const client = run.connection.client
  const directory = session.location.directory
  const shell = /^!(.+)/s.exec(text)?.[1]?.trim()
  // A shell command is not a prompt, so it cannot carry a staged undo.
  if (shell && session.revert) throw new AgentError("Commit or clear the staged undo before running a shell command.")
  const command = shell ? undefined : await run.connection.resolveCommand(text, directory, session.location.workspaceID)
  if ((shell || command) && delivery === "queue")
    throw usage(`${shell ? "Shell commands" : "Slash commands"} do not support --queue. Send without it.`)
  // Every local check runs here, before anything is sent.
  if (shell) {
    run.connection.checkShell(session.id, messageID, shell)
    return () => run.connection.shell(session.id, messageID, shell)
  }
  if (command) return () => client.sessions.command({ sessionID: session.id, id: messageID, ...command, resume: true })
  checkOutside(run, text, directory)
  const prompt = promptPayload(text, directory)
  return () => client.sessions.prompt({ sessionID: session.id, id: messageID, prompt, delivery })
}

/** A subagent session that a task owns takes no direct replies; its owning session does. */
async function refuseOwned(run: Run, session: Session) {
  if (!session.parentID) return
  const tasks = await run.connection.client.sessions
    .taskList({ sessionID: session.parentID, limit: 50 })
    .catch(() => undefined)
  if (tasks && [...tasks.data, ...tasks.active].some((task) => task.childSessionID === session.id))
    throw new AgentError(ownedText(session))
}

function owned(session: Session, error: unknown) {
  const kind = typeof error === "object" && error && "kind" in error ? error.kind : undefined
  return kind === "session_task_owned" ? new AgentError(ownedText(session)) : undefined
}

function ownedText(session: Session) {
  const parent = session.parentID ? ` ${session.parentID}` : ""
  return `Session ${session.id} (${clean(session.title, 80)}) is a task-owned subagent and takes no direct replies. Send to its owning session${parent} instead. Nothing was sent.`
}
