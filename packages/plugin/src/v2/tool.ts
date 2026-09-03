/**
 * Shapes shared by the Effect and Promise `tool.execute` hook surfaces.
 *
 * A tool call settles in exactly one place, so both hooks describe that one boundary rather
 * than the eight trigger sites the V1 hook bus fired from. `before` runs against the raw,
 * still-undecoded provider arguments -- the only representation where replacing them is
 * meaningful, since the host re-decodes whatever a hook hands back through the tool's own
 * input schema. `after` runs against the settled result the model is about to see.
 */

/** What one `execute.before` hook decided about a pending call. Absent means "no opinion". */
export type ToolExecuteDecision =
  /** Refuse the call. It never executes; the model receives `reason` as the tool error. */
  | { readonly type: "deny"; readonly reason: string }
  /** Replace the raw arguments. The host re-decodes them against the tool's input schema. */
  | { readonly type: "replace"; readonly input: unknown }

export interface ToolExecuteIdentity {
  readonly sessionID: string
  /** The agent whose policy authorized this call. Subagent calls carry the child agent. */
  readonly agent: string
  readonly assistantMessageID: string
  readonly callID: string
  /** Registered tool name, e.g. `write`. */
  readonly tool: string
}

export interface ToolExecuteBefore extends ToolExecuteIdentity {
  /** Raw provider arguments, before the tool's input schema has decoded them. */
  readonly input: unknown
  /**
   * Set to influence the call. Hooks run in registration order and each one sees the previous
   * hook's replacement, so `replace` composes. `deny` is terminal: later hooks are not consulted
   * and no hook can undo it.
   */
  decision?: ToolExecuteDecision
}

/** The settled tool result, mirroring the host's canonical result union. */
export interface ToolExecuteResult {
  readonly type: "json" | "text" | "error" | "content"
  readonly value: unknown
}

export interface ToolExecuteAfter extends ToolExecuteIdentity {
  /** The arguments the tool actually ran with, after any `before` replacement. */
  readonly input: unknown
  /** Exactly what the model will see. Read-only: the settlement is the record. */
  readonly result: ToolExecuteResult
  /** True when a `before` hook denied the call, so `result` is the synthetic denial error. */
  readonly denied: boolean
  /**
   * Advisory text appended to the model-visible output, in registration order. Push-only: a hook
   * can add context to a settled result but cannot remove or contradict what the tool reported.
   * Ignored for denied and failed calls. The host bounds both the count and the length.
   */
  readonly notes: string[]
}

export interface ToolExecuteSpec {
  readonly before: ToolExecuteBefore
  readonly after: ToolExecuteAfter
}
