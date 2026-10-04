export const agentCommands = [
  "sessions",
  "show",
  "send",
  "wait",
  "pending",
  "approve",
  "reject",
  "answer",
  "stop",
] as const

export type AgentCommand = (typeof agentCommands)[number]

export function isAgentCommand(word: string | undefined): word is AgentCommand {
  return agentCommands.some((command) => command === word)
}

/** The block `turen-tui --help` shows after the dashboard options. */
export const agentOverview = `Agent and script commands (no terminal needed; add --json for one JSON document):
  sessions                 Recent sessions and their state (running, needs-input, idle)
  show <session>           A session's transcript and pending requests
  send <session> [text]    Reply to a session; "-" reads stdin; --new starts a session
  wait <session>           Block until the session is idle or needs input
  pending [session]        Pending permissions and questions, with the commands that resolve them
  approve <session> <id>   Allow a permission request once (--always saves its rule)
  reject <session> <id>    Reject a permission request
  answer <session> <id>    Answer a question: --choice <label>, --answers <json> or --reject
  stop <session>           Interrupt a session (--tasks also cancels its subagent tasks)

Examples:
  turen-tui sessions --json
  turen-tui send --new "fix the failing test" --dir /srv/app --wait
  turen-tui pending
  turen-tui approve ses_abc per_123 && turen-tui wait ses_abc
Exit codes: 0 done, 1 failed, 2 usage, 3 needs input, 4 timeout. Each command takes --help.`
