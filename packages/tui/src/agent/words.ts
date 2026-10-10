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
  "team",
] as const

/**
 * A word in the command position that is not a URL, which has a scheme, a dot, a port or digits: a lowercase word, or a
 * capitalised spelling of a command (`Sessions`). Any other capitalised word is a host name and opens the dashboard.
 */
export function isCommandWord(word: string | undefined): word is string {
  if (word === undefined) return false
  return /^[a-z][a-z-]*$/.test(word) || (/^[A-Za-z]+$/.test(word) && isAgentCommand(word.toLowerCase()))
}

/** The usage error for a word that is not a command, naming the nearest command when it is a likely typo. */
export function unknownCommand(word: string | undefined) {
  const named = isCommandWord(word) ? word : undefined
  if (named === undefined) return "Unknown command. Run turen-tui --help for the list."
  const nearest = agentCommands
    .map((command) => ({ command, distance: distance(named.toLowerCase(), command) }))
    .sort(byDistance)[0]
  const hint = nearest && nearest.distance <= 2 ? ` Did you mean "${nearest.command}"?` : ""
  return `Unknown command "${named}".${hint} Run turen-tui --help for the list.`
}

function byDistance(a: { distance: number }, b: { distance: number }) {
  return a.distance - b.distance
}

/** Levenshtein edit distance. */
export function distance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
  return rows[a.length]![b.length]!
}

export type AgentCommand = (typeof agentCommands)[number]

export function isAgentCommand(word: string | undefined): word is AgentCommand {
  return agentCommands.some((command) => command === word)
}

/** The block `turen-tui --help` shows after the dashboard options. */
export const agentOverview = `Agent and script commands (no terminal needed; add --json for one JSON document):
  sessions                 Recent sessions in this folder and their state (--everywhere for every folder)
  show <session>           A session's transcript and pending requests
  send <session> [text]    Reply to a session; "-" reads stdin; --new starts a session
  wait <session>           Block until the session is idle or needs input
  pending [session]        Pending permissions and questions, with the commands that resolve them
  approve <session> <id>   Allow a permission request once (--always saves its rule)
  reject <session> <id>    Reject a permission request
  answer <session> <id>    Answer a question: --choice <label>, --answers <json> or --reject
  stop <session>           Interrupt a session (--tasks also cancels its subagent tasks)
  team <subcommand>        Team rooms: rooms, show, post, run, cancel, wait (factory runs)

Examples:
  turen-tui sessions --json
  turen-tui send --new "fix the failing test" --dir /srv/app --wait
  turen-tui pending
  turen-tui approve ses_abc per_123 && turen-tui wait ses_abc
  turen-tui team post team "@moss review the diff"
On a server on this computer, sessions, pending and send --new use the folder you run them in,
unless that is your home folder; commands that name a session work on any session.
Exit codes: 0 done, 1 failed, 2 usage, 3 needs input, 4 timeout, 5 turn failed. Each command takes --help.`
