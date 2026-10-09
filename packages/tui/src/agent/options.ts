import { parseArgs } from "node:util"
import { usage } from "./errors"
import type { AgentCommand } from "./words"

/** Every option any agent command accepts; each command lists the ones it allows. */
export type Values = {
  url?: string
  server?: string
  username?: string
  "discover-auth"?: boolean
  json?: boolean
  help?: boolean
  dir?: string
  limit?: string
  all?: boolean
  raw?: boolean
  new?: boolean
  queue?: boolean
  wait?: boolean
  timeout?: string
  id?: string
  "session-id"?: string
  model?: string
  variant?: string
  agent?: string
  "allow-outside"?: boolean
  always?: boolean
  choice?: string[]
  answers?: string
  reject?: boolean
  custom?: boolean
  tasks?: boolean
}

const text = { type: "string" } as const
const flag = { type: "boolean" } as const

const common = {
  url: text,
  server: text,
  username: text,
  "discover-auth": flag,
  json: flag,
  help: { type: "boolean", short: "h" },
} as const

const extra = {
  sessions: { dir: text, limit: text, all: flag },
  show: { limit: text, all: flag, raw: flag },
  send: {
    new: flag,
    queue: flag,
    wait: flag,
    timeout: text,
    id: text,
    "session-id": text,
    dir: text,
    model: text,
    variant: text,
    agent: text,
    "allow-outside": flag,
  },
  wait: { timeout: text },
  pending: {},
  approve: { always: flag },
  reject: {},
  answer: { choice: { type: "string", multiple: true }, answers: text, reject: flag, custom: flag },
  stop: { tasks: flag },
  team: { all: flag, limit: text, id: text, timeout: text },
} as const

export function parseCommand(command: AgentCommand, args: string[]) {
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: { ...common, ...extra[command] },
    })
    return { values: parsed.values as Values, positionals: parsed.positionals }
  } catch {
    // parseArgs errors may echo argument values, including misplaced credentials.
    throw usage(
      `Invalid arguments. Run turen-tui ${command} --help for usage. A value that starts with "-" goes after "--", or as --option=value.`,
    )
  }
}

/** A whole number option within bounds; the flag name is the only thing echoed back. */
export function whole(name: string, value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback
  const number = /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN
  if (!(number >= min && number <= max)) throw usage(`--${name} must be a whole number from ${min} to ${max}.`)
  return number
}

/** The positionals of a command, exactly `names.length` required and `optional` more allowed. */
export function takes(command: string, positionals: string[], names: string[], optional: string[] = []) {
  if (positionals.length < names.length || positionals.length > names.length + optional.length)
    throw usage(
      `Usage: turen-tui ${command} ${[...names.map((name) => `<${name}>`), ...optional.map((name) => `[${name}]`)].join(" ")}`,
    )
  return positionals
}
