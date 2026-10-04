/** What a command reports instead of succeeding: the message, the exit code, and the ID a retry must reuse. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly exit: 1 | 2 | 3 | 4 = 1,
    readonly retry?: { id: string; sessionID?: string },
  ) {
    super(message)
    this.name = "AgentError"
  }
}

export function usage(message: string) {
  return new AgentError(message, 2)
}
