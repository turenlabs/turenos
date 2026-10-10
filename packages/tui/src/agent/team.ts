import type { Run } from "./context"
import { usage } from "./errors"
import { post } from "./team-post"
import { cancelRun, startRun } from "./team-run"
import { rooms } from "./team-room"
import { show } from "./team-show"
import { waitRun } from "./team-wait"

const subcommands = { rooms, show, post, run: startRun, cancel: cancelRun, wait: waitRun }
type Subcommand = keyof typeof subcommands

/** The options each subcommand takes besides the target options every command takes. */
const own: Record<Subcommand, readonly string[]> = {
  rooms: ["all"],
  show: ["limit"],
  post: ["id"],
  run: ["id"],
  cancel: [],
  wait: ["timeout"],
}

/** `team <subcommand>`: Team rooms, messages and factory runs for scripts. */
export async function team(run: Run) {
  const name = run.positionals[0]
  const subcommand = (Object.keys(subcommands) as Subcommand[]).find((item) => item === name)
  if (!subcommand)
    throw usage(`Use one of: ${Object.keys(subcommands).join(", ")}. Run turen-tui team --help for usage.`)
  const stray = (["all", "limit", "id", "timeout"] as const).filter(
    (option) => run.values[option] !== undefined && !own[subcommand].includes(option),
  )
  if (stray.length) throw usage(`team ${subcommand} does not take ${stray.map((option) => `--${option}`).join(", ")}.`)
  return subcommands[subcommand]({ ...run, positionals: run.positionals.slice(1) })
}
