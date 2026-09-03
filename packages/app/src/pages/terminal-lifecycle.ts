// Marks a connect error where the server confirmed the PTY no longer exists
// (pty.get returned 404 after the socket failed). Only this signal may trigger
// restored-PTY recovery: everything else - a token fetch that threw on a flaky
// network, a 403, a setup failure - can happen while the PTY is alive, and
// recovering there would close() a live PTY and silently kill the running shell.
export class TerminalPtyGoneError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Terminal PTY not found", { cause })
    this.name = "TerminalPtyGoneError"
  }
}

// A PTY restored from the persisted workspace store may be stale. Grants
// exactly one recovery launch per restored PTY id so a connect
// error falls through to a fresh shell instead of the error panel, without ever
// looping - and only for a server-confirmed dead PTY (TerminalPtyGoneError);
// transient errors land on the error panel and keep the grant, so a genuine
// dead-PTY signal arriving later can still recover.
export function takePersistedPtyRecovery(restored: Set<string>, id: string, error: unknown) {
  if (!(error instanceof TerminalPtyGoneError)) return false
  if (!restored.has(id)) return false
  restored.delete(id)
  return true
}
