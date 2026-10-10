import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadRecord, packageDir, paths } from "./run"
import { sandboxEnv } from "./server"

/**
 * Drives the TUI in a tmux server private to one sandbox (`tmux -S <run>/tmux`), never the
 * user's default server. Screens are read as plain text, the way an agent sees them.
 */
export type Size = { cols: number; rows: number }

const target = "tui:0.0"

/** Key names beyond tmux's own: OpenTUI reads these modified Enter keys as CSI-u sequences. */
const sequences: { [key: string]: string } = {
  "S-Enter": "\u001b[13;2u",
  "M-Enter": "\u001b\r",
  "C-Enter": "\u001b[13;5u",
}

export function open(
  name: string,
  size: Size = { cols: 120, rows: 36 },
  options: { cli?: string; args?: string[] } = {},
) {
  const record = loadRecord(name)
  const p = paths(name)
  if (existsSync(p.socket)) tmux(name, "kill-server")
  const cli = options.cli ?? join(packageDir, "src/cli.ts")
  // The password is read inside the pane's shell, so it never appears in any argv.
  const launch = [
    `FORGE_SERVER_PASSWORD="$(cat '${p.password}')"`,
    "exec bun",
    quote(cli),
    "--dir",
    quote(record.project),
    ...(options.args ?? []).map(quote),
    quote(record.url),
  ].join(" ")
  const script = `( ${launch} ) 2>>'${p.tuiLog}'; status=$?; printf '\\n[sandbox] turen-tui exited with status %s\\n' "$status"; exec sleep 2147483647`
  tmux(
    name,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "tui",
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
    "/bin/sh",
    "-c",
    script,
  )
  tmux(name, "set-option", "-t", "tui", "status", "off")
  tmux(name, "set-option", "-s", "exit-empty", "off")
}

export function screen(name: string, color = false) {
  return tmux(name, "capture-pane", "-p", ...(color ? ["-e"] : []), "-t", target)
}

/** Sends key names (`Enter`, `C-s`, `Escape`, `PageDown`, `S-Enter`, a single character). */
export async function keys(name: string, ...names: string[]) {
  for (const key of names) {
    if (sequences[key]) tmux(name, "send-keys", "-t", target, "-l", "--", sequences[key]!)
    else tmux(name, "send-keys", "-t", target, "--", key)
    // A lone Escape followed at once by another byte reads as Alt+key; give the parser a gap.
    if (key === "Escape" || key === "Esc") await Bun.sleep(120)
    else await Bun.sleep(15)
  }
}

/** Types text literally, as if pasted key by key. */
export async function type(name: string, text: string) {
  tmux(name, "send-keys", "-t", target, "-l", "--", text)
  await Bun.sleep(30)
}

export function resize(name: string, size: Size) {
  tmux(name, "resize-window", "-t", "tui:0", "-x", String(size.cols), "-y", String(size.rows))
}

/** Polls the screen until `pattern` matches; returns the screen, or throws with it on timeout. */
export async function waitFor(
  name: string,
  pattern: RegExp | string | ((screen: string) => boolean),
  timeout = 15_000,
) {
  const test =
    typeof pattern === "string"
      ? (value: string) => value.includes(pattern)
      : typeof pattern === "function"
        ? pattern
        : (value: string) => pattern.test(value)
  const deadline = Date.now() + timeout
  while (true) {
    const value = screen(name)
    if (test(value)) return value
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeout} ms waiting for ${String(pattern)}. Screen:\n${value}`)
    await Bun.sleep(100)
  }
}

/** Waits until the screen stops changing for `quiet` ms (spinners count as changes). */
export async function settle(name: string, quiet = 500, timeout = 10_000) {
  const deadline = Date.now() + timeout
  const state = { last: screen(name), since: Date.now() }
  while (Date.now() - state.since < quiet) {
    if (Date.now() > deadline) return state.last
    await Bun.sleep(50)
    const value = screen(name)
    if (value !== state.last) Object.assign(state, { last: value, since: Date.now() })
  }
  return state.last
}

/** `true` once the TUI process has exited (the pane keeps its last output). */
export function exited(name: string) {
  return screen(name).includes("[sandbox] turen-tui exited with status")
}

export function close(name: string) {
  if (existsSync(paths(name).socket)) tmux(name, "kill-server")
}

export function attachCommand(name: string) {
  return `tmux -S ${paths(name).socket} attach -t tui`
}

function tmux(name: string, ...args: string[]) {
  // The private server takes its global environment from the client that starts it: the
  // sandbox's allowlisted environment, never this shell's (no TMUX, keys or server URLs).
  const env = { ...sandboxEnv(paths(name)), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" }
  const result = spawnSync("tmux", ["-S", paths(name).socket, ...args], { encoding: "utf8", timeout: 15_000, env })
  if (result.status !== 0 && args[0] !== "kill-server")
    throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
