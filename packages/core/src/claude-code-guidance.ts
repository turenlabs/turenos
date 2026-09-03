export * as ClaudeCodeGuidance from "./claude-code-guidance"

export const WORKFLOW = `TurenOS tool workflow:
- For non-trivial repository exploration, begin with one broad search across all plausible locations instead of serial path guesses. If a search misses, widen its root or pattern rather than trying nearby paths one by one.
- When available, prefer Glob, Grep, and Read for file discovery, content search, and targeted reads. Do not use a serial chain of Shell ls/find/grep/cat probes when a specialized tool can answer directly.
- Issue genuinely independent searches, reads, and diagnostics together in the same response so they can run in parallel. Keep dependent work and conflicting writes sequential.
- If currently available subagent tools would materially help, use them to spawn disjoint, bounded work early in the first exploration wave and in parallel within any advertised limit. Do not delegate trivial lookups or duplicate work; otherwise continue directly.
- Treat the current tool catalog and dynamic subagent guidance as authoritative. Once the evidence is sufficient, stop exploring and proceed with the requested work.`

export type ToolCall = {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

export type WorkflowState = {
  serialExplorationBatches: number
  reminders: number
}

export const workflowState = (): WorkflowState => ({ serialExplorationBatches: 0, reminders: 0 })

const toolName = (value: string) => value.replace(/^mcp__forge__/, "").toLowerCase()

const shellDiscovery = (input: Readonly<Record<string, unknown>>) => {
  if (
    typeof input.command !== "string" ||
    /(?:>>?|<<)|\bsed\b[^\n]*\s(?:--in-place(?:=\S*)?|-[A-Za-z]*i[A-Za-z]*\S*)/i.test(input.command)
  )
    return false
  return /^\s*(?:(?:cd|pushd)\b[^;&|]*(?:&&|;)\s*)?(?:(?:git\s+(?:grep|ls-files))|ls|find|grep|rg|cat|head|tail|sed|awk|tree|stat|file)\b/i.test(
    input.command,
  )
}

const exploration = (call: ToolCall) => {
  const name = toolName(call.name)
  if (name === "glob" || name === "grep" || name === "read") return true
  return (name === "bash" || name === "shell") && shellDiscovery(call.input)
}

const subagent = (call: ToolCall) => {
  const name = toolName(call.name)
  return name === "agent" || name === "task" || name === "spawn_agent"
}

export const workflowReminder = (
  state: WorkflowState,
  calls: ReadonlyArray<ToolCall>,
  options: { readonly subagents: boolean },
) => {
  if (calls.some(subagent) || calls.length !== 1 || !calls.every(exploration)) {
    state.serialExplorationBatches = 0
    return
  }
  state.serialExplorationBatches++
  if (state.serialExplorationBatches < 2 || state.reminders >= 2) return
  state.serialExplorationBatches = 0
  state.reminders++
  return [
    "TurenOS workflow reminder: you are exploring one tool call at a time.",
    "Before the next probe, widen the search root or pattern and issue genuinely independent searches or reads together in one response.",
    ...(options.subagents
      ? ["If independent questions remain, use the available subagent tools now for disjoint, bounded parallel work."]
      : []),
    "Do not repeat another narrow Shell discovery probe when Glob, Grep, or Read can answer directly.",
  ].join(" ")
}
