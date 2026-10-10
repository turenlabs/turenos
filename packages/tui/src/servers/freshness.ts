import { readFile, stat } from "node:fs/promises"

/** File timestamps and process start times are both rounded to whole seconds somewhere. */
const TOLERANCE_MS = 2000

/** Linux's USER_HZ, the unit of /proc/<pid>/stat start times, is 100 on every supported architecture. */
const CLOCK_TICKS = 100

/**
 * A record names a live pid, but pids are reused: a stale record whose pid now belongs to another
 * process would send its password to whatever holds the port. A record its owner wrote cannot be
 * older than that owner's process, so refuse any file last written before the pid started.
 *
 * Fails closed where the start time can be read (Linux, macOS) and is unreadable. Elsewhere there
 * is no source to check against, so the pid check alone applies.
 */
export async function writtenSinceStart(pid: number, files: string[]) {
  const started = await startedAt(pid)
  if (started === undefined) return process.platform !== "linux" && process.platform !== "darwin"
  const modified = await Promise.all(files.map((file) => stat(file).then((info) => info.mtimeMs, () => undefined)))
  return modified.every((time) => time !== undefined && time + TOLERANCE_MS >= started)
}

async function startedAt(pid: number) {
  if (process.platform === "linux") return linuxStart(pid)
  if (process.platform === "darwin") return darwinStart(pid)
  return undefined
}

async function linuxStart(pid: number) {
  const [stat, system] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined),
    readFile("/proc/stat", "utf8").catch(() => undefined),
  ])
  // The command name is parenthesised and may itself contain spaces or parentheses; fields resume after the last one.
  const ticks = Number(stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19])
  const boot = Number(/^btime (\d+)$/m.exec(system ?? "")?.[1])
  if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return undefined
  return boot * 1000 + (ticks / CLOCK_TICKS) * 1000
}

async function darwinStart(pid: number) {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  const time = Date.parse((await new Response(child.stdout).text()).trim())
  return Number.isFinite(time) ? time : undefined
}
