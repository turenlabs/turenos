export * as TurnInterruption from "./turn-interruption"

// The error messages the session runner records when it stops work before it finishes, so clients
// can show a stopped turn as interrupted rather than failed. No imports:
// `@turenlabs/client/turn-interruption` re-exports this for clients that do not load `effect`.

/** An assistant message whose provider turn was stopped. */
export const TURN = "Provider turn interrupted"
/** An assistant message stopped while waiting to retry, before its provider turn began. */
export const BEFORE_START = "Provider turn interrupted before it started"
/** An assistant message stopped while the tools of a finished provider turn were settling. */
export const SETTLEMENT = "Tool execution interrupted during settlement"
/** A tool call stopped before it returned. */
export const TOOL = "Tool execution interrupted"

/** True when an assistant message's error says its turn was stopped, not that it failed. */
export const isTurnInterrupted = (message: string) =>
  message === TURN || message === BEFORE_START || message === SETTLEMENT
