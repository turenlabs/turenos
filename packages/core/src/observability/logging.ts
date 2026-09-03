import { Formatter, Logger, type LogLevel } from "effect"
import { renameSync, rmSync, statSync } from "node:fs"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

/**
 * `forge.log` had no rotation, cap, or sweep — it grew for the life of the install. The Effect
 * file logger cannot rotate mid-run, so rotation happens at logger construction: an oversized
 * log is renamed to `.1`, replacing the previous archive. Bounded at ~2x the cap, no sweeper.
 */
const MAX_LOG_BYTES = 10 * 1024 * 1024

function rotate(file: string) {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return
    // Two steps because Windows rename does not reliably replace an existing target.
    rmSync(`${file}.1`, { force: true })
    renameSync(file, `${file}.1`)
  } catch {
    // A missing file or unwritable directory must never block logger construction.
  }
}

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

export function fileLogger(file = path.join(Global.Path.log, "forge.log"), id: string = runID) {
  rotate(file)
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Logger.toFile(formatter(id), file, { flag: "a" })
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.FORGE_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.FORGE_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
