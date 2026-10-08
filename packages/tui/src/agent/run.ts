import { errorText, httpStatus } from "../server"
import { CliError } from "../tui-auth"
import { answer } from "./answer"
import { clean, targetFlags } from "./context"
import { openServer } from "./endpoint"
import { AgentError, usage } from "./errors"
import { commandHelp } from "./help"
import type { Io } from "./io"
import { parseCommand } from "./options"
import { approve, reject } from "./permissions"
import { pending } from "./pending"
import { send } from "./send"
import { sessions } from "./sessions"
import { show } from "./show"
import { stop } from "./stop"
import { team } from "./team"
import { wait } from "./wait"
import { isAgentCommand, unknownCommand } from "./words"

const commands = { sessions, show, send, wait, pending, approve, reject, answer, stop, team }

/** Runs one agent command and returns its exit code: 0 done, 1 failed, 2 usage, 3 needs input, 4 timeout, 5 failed turn. */
export async function runAgent(args: string[], io: Io) {
  try {
    return await dispatch(args, io)
  } catch (error) {
    return report(error, io, args.includes("--json"))
  }
}

async function dispatch(args: string[], io: Io) {
  const command = args[0]
  if (!isAgentCommand(command)) throw usage(unknownCommand(command))
  const parsed = parseCommand(command, args.slice(1))
  if (parsed.values.help) {
    io.stdout(commandHelp(command))
    return 0
  }
  const server = await openServer(parsed.values, io)
  try {
    return await commands[command]({
      connection: server.connection,
      io,
      values: parsed.values,
      positionals: parsed.positionals,
      flags: targetFlags(parsed.values),
    })
  } catch (error) {
    throw server.unauthorized && httpStatus(error) === 401 ? new AgentError(server.unauthorized) : error
  } finally {
    server.close()
  }
}

function report(error: unknown, io: Io, json: boolean) {
  const known = error instanceof AgentError || error instanceof CliError
  // One line: a server message must not add lines that read as this client's own.
  const message = clean(known ? error.message : errorText(error), 2000)
  io.stderr(`turen-tui: ${message}\n`)
  const retry = error instanceof AgentError ? error.retry : undefined
  const detail = error instanceof AgentError ? error.detail : undefined
  if (json) io.stdout(`${JSON.stringify({ error: { message, ...(retry ? { retry } : {}), ...detail } })}\n`)
  if (error instanceof AgentError) return error.exit
  return error instanceof CliError ? 2 : 1
}
