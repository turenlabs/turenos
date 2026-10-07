import { display } from "../messages"
import type { Connection } from "../server"
import type { Io } from "./io"
import type { Values } from "./options"

/** What one command run shares: the open connection, the process edges and the parsed arguments. */
export type Run = {
  connection: Connection
  io: Io
  values: Values
  positionals: string[]
  /** The target options the user passed, for the follow-up commands this run suggests. */
  flags: string
}

/** One line of server text with controls removed, safe to print into a terminal. */
export function clean(value: string, limit = 400) {
  return display(value, limit).replace(/\s+/g, " ").trim()
}

/** A shell word that survives copy and paste: double quotes unless the text needs single quotes. */
export function quote(value: string) {
  if (!/["$`\\!]/.test(value)) return `"${value}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function targetFlags(values: Values) {
  return [
    values.url !== undefined ? ` --url ${quote(values.url)}` : "",
    values.server !== undefined ? ` --server ${quote(values.server)}` : "",
    values.username !== undefined ? ` --username ${quote(values.username)}` : "",
    values["discover-auth"] ? " --discover-auth" : "",
  ].join("")
}

/** Prints one JSON document, or the text, and returns the success exit code. */
export function emit(run: Run, json: unknown, text: string, exit = 0) {
  run.io.stdout(run.values.json ? `${JSON.stringify(json)}\n` : `${text}\n`)
  return exit
}

/**
 * Transcript text set in by four spaces: the lines this client prints start in column 0, or at two
 * spaces under a request, so a caller can tell its own lines from anything a message contains.
 */
export function indented(text: string) {
  return text
    .split("\n")
    .map((line) => (line ? `    ${line}` : line))
    .join("\n")
}

export function isoTime(milliseconds: number) {
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString()
}
