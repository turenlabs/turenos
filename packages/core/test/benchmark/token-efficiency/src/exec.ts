export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  wallMs: number
}

/**
 * Run a command to completion with a hard timeout.
 *
 * stdin is closed rather than inherited: Codex in particular will block reading
 * a piped stdin, and an inherited TTY changes every harness's output mode.
 */
export async function exec(args: {
  cmd: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}): Promise<ExecResult> {
  const started = Date.now()
  const proc = Bun.spawn(args.cmd, {
    cwd: args.cwd,
    env: args.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, args.timeoutMs)

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  clearTimeout(timer)

  return { stdout, stderr, exitCode, timedOut, wallMs: Date.now() - started }
}

/** Parse NDJSON leniently: non-JSON lines (log noise) are skipped, not fatal. */
export function parseNdjson(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>)
    } catch {
      // A truncated or interleaved line. Skipping is correct; the harness
      // parsers below fail loudly if the events they need never arrive.
    }
  }
  return out
}

/** Environment shared by every harness: no colour, no TTY assumptions. */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env["NO_COLOR"] = "1"
  env["CI"] = "1"
  return env
}
