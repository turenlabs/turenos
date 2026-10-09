import type { AgentCommand } from "./words"

const target = `Server options (all commands):
  --url <origin>      Server to use (else TURENOS_SERVER_URL, else the local TurenOS)
  --server <name>     A saved server instead
  --username <name>   Basic auth username (else FORGE_SERVER_USERNAME, else forge)
  --discover-auth     Discover local auth for http://127.0.0.1:4096 (Linux, same user)
  --json              Print one JSON document; errors become {"error": {"message"}}
The password comes only from FORGE_SERVER_PASSWORD. Exit codes: 0 done, 1 failed, 2 usage,
3 needs input, 4 timeout, 5 the turn failed or was interrupted.`

const commands: Record<AgentCommand, string> = {
  sessions: `Usage: turen-tui sessions [--dir <path> | --everywhere] [--limit N] [--all]

List recent sessions: id, state, updated time, directory, parent and title. On a server on this
computer they are the sessions of the folder you run it in, unless that is your home folder; a first
line names the folder. A project's root folder includes the project's worktrees.
State is running, needs-input (a pending permission or question), failed or interrupted (the
latest turn ended in error or was stopped) or idle.
  --dir <path>   Only sessions in this server folder instead
  --everywhere   Sessions in every folder
  --limit N      How many to list (1-100, default 30)
  --all          Include archived sessions`,
  show: `Usage: turen-tui show <session> [--limit N] [--all] [--raw]

Print the transcript and any pending requests with the commands that resolve them.
  --limit N   Latest N messages (1-30, default 30)
  --all       Follow the history to its start, oldest first (at most 2,000 messages)
  --raw       Show reasoning and tool output as plain text`,
  send: `Usage: turen-tui send <session> [text | -] [--queue] [--wait] [--timeout S] [--id msg_...]
       turen-tui send --new [text | -] [--dir D] [--model provider/model] [--variant V] [--agent A]
                      [--wait] [--timeout S] [--id msg_...] [--session-id ses_...]

Reply to a session, or start one with --new. The text is the argument, or stdin for "-" or no
argument. A leading / runs a server command and a leading ! runs a shell command on the server;
neither supports --queue. Delivery is steer unless --queue.
  --wait        Wait for the reply (exit 3 if the session needs input, 4 on timeout, 5 if the turn failed)
  --timeout S   Seconds to wait, default 600, 0 for no limit
  --id          Message ID. After "Outcome unknown", retry with the same ID: the server drops duplicates
  --allow-outside   Attach @file mentions that leave the session directory
--new starts in --dir, else in the folder you run it in on a server on this computer (unless that is
your home folder), else in the server's own directory.
Text that starts with "-" goes after "--" (turen-tui send ses_x -- "- a list item") or on stdin.
With --wait, input a subagent of the session is waiting for also ends the wait (exit 3).`,
  wait: `Usage: turen-tui wait <session> [--timeout S]

Block until the session is idle (prints its last reply) or needs input (prints the requests, exit 3).
Input a subagent of the session is waiting for counts too. Exit 4 on timeout (default 600 s, 0 for no
limit), 5 when the turn failed or was interrupted. A server that stops answering is polled again, more
slowly, until the timeout.`,
  pending: `Usage: turen-tui pending [<session>] [--dir <path> | --everywhere]

List pending permissions and questions for one session, or for every running session in the folder
you run it in, as sessions lists them.
  --dir <path>   Running sessions in this server folder instead
  --everywhere   Running sessions in every folder`,
  approve: `Usage: turen-tui approve <session> <permission-id> [--always]

Allow a permission request once. --always also saves the rule the request offers.`,
  reject: `Usage: turen-tui reject <session> <permission-id>

Reject a permission request.`,
  answer: `Usage: turen-tui answer <session> <question-id> (--choice <label>... | --answers <json> | --reject) [--custom]

  --choice <label>   For a request with one question; repeat it to select several options
                     (write --choice=<label> for a label that starts with "-")
  --answers <json>   A JSON array with one array of labels per question, e.g. '[["Red"],["Yes"]]'
  --reject           Dismiss the question
  --custom           Send a label as a custom answer without the near-miss check
A label outside the options is accepted only when the question allows custom answers. A label one
edit from an option ("Rd" for "Red") is refused as a likely typo; --custom sends it as typed.`,
  stop: `Usage: turen-tui stop <session> [--tasks]

Interrupt the running session and its unfinished subagent tasks through the server.
An idle parent is not interrupted unless --tasks is given; that also cancels its unfinished
subagent tasks. --json with --tasks reports tasks.status as cancelled, without per-task counts.`,
  team: `Usage: turen-tui team rooms [--all]
       turen-tui team show [<room>] [--limit N]
       turen-tui team post <room> [text | -] [--id msg_...]
       turen-tui team run <room> [request | -] [--id <run-id>]
       turen-tui team cancel <run-id>
       turen-tui team wait <run-id> [--timeout S]

Read and write Team rooms. <room> is a room ID (trm_...) or an exact room name in any case; show
without a room reads the server's default room.
  rooms    List rooms: id, name and topic (--all includes archived rooms, marked archived)
  show     Teammates, the latest N messages (1-100, default 30), active tasks and the factory's latest run
  post     Post a message; a mention creates a task for that teammate, else the coordinator replies.
           Prints each task with the command that waits for its session
  run      Start one factory run (the request is optional, at most 4,000 characters)
  cancel   Cancel a factory run and print its final status
  wait     Block until the run leaves running: exit 0 succeeded, 3 needs input (the task sessions and
           their pending requests are printed), 5 failed, cancelled or stale, 4 timeout (default 600 s,
           0 for no limit)
  --id     Message or run ID. After "Outcome unknown", retry with the same ID: the server drops duplicates`,
}

export function commandHelp(command: AgentCommand) {
  return `${commands[command]}\n\n${target}\n`
}
