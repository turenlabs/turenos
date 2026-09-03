export type AutomationCommand = {
  name: string
  intervalSeconds: number
  prompt: string
}

export type LoopCommand = {
  prompt: string
  intervalSeconds: number
  maxIterations?: number
}

export type LoopCommandResult =
  | { type: "none" }
  | { type: "invalid"; message: string }
  | { type: "loop"; value: LoopCommand }

export type AutomationCommandResult =
  | { type: "none" }
  | { type: "invalid"; message: string }
  | { type: "automation"; value: AutomationCommand }

const UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const

/** Parses the deterministic `/loop <interval> <prompt>` grammar for in-session autonomous loops. */
export function parseLoopCommand(text: string): LoopCommandResult {
  if (text !== "/loop" && !text.startsWith("/loop ")) return { type: "none" }

  const match = text.match(/^\/loop ([1-9]\d*)([smhd]) (\S[\s\S]*)$/)
  if (!match) return { type: "invalid", message: "Use /loop <integer><s|m|h|d> <prompt>" }

  const intervalSeconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS]
  if (!Number.isSafeInteger(intervalSeconds)) return { type: "invalid", message: "The loop interval is too large" }
  if (intervalSeconds < 60) return { type: "invalid", message: "Loop intervals must be at least 60 seconds" }

  const prompt = match[3].trimEnd()
  return { type: "loop", value: { prompt, intervalSeconds } }
}

/** Parses only the deliberately small, deterministic `/automation` grammar. */
export function parseAutomationCommand(text: string): AutomationCommandResult {
  if (text !== "/automation" && !text.startsWith("/automation ")) return { type: "none" }

  const match = text.match(/^\/automation ([1-9]\d*)([smhd]) (\S[\s\S]*)$/)
  if (!match) return { type: "invalid", message: "Use /automation <integer><s|m|h|d> <prompt>" }

  const intervalSeconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS]
  if (!Number.isSafeInteger(intervalSeconds))
    return { type: "invalid", message: "The automation interval is too large" }
  if (intervalSeconds < 60) return { type: "invalid", message: "Automation intervals must be at least 60 seconds" }

  const prompt = match[3].trimEnd()
  return { type: "automation", value: { name: prompt, intervalSeconds, prompt } }
}
