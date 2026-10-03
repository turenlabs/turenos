import { start, keystrokes, resized } from "./attach/session"
import type { AttachOptions, AttachResult, Session } from "./attach/types"
import { identifier } from "./response-validation"

export { DETACH } from "./attach/types"
export type { AttachTarget } from "./attach/types"

/**
 * Joins this terminal to a server PTY, the way the desktop's terminal pane does: a single-use
 * ticket opens the PTY's WebSocket, output replays and then streams, keystrokes go back as text,
 * and the size follows this terminal. Resolves when Ctrl+] detaches or the PTY ends.
 */
export function attachTerminal(input: AttachOptions): Promise<AttachResult> {
  const target = input.target
  identifier(target.id, "pty_")
  return new Promise((resolve) => {
    const session: Session = {
      options: input,
      open: input.socket ?? ((url: string) => new WebSocket(url)),
      decoder: new TextDecoder("utf-8"),
      location: {
        "location[directory]": target.directory,
        ...(target.workspace ? { "location[workspace]": target.workspace } : {}),
      },
      cursor: undefined,
      socket: undefined,
      finished: false,
      attempts: 0,
      pending: { text: [], bytes: 0 },
      resolve,
      listeners: { keystrokes: (chunk) => keystrokes(session, chunk), resized: () => resized(session) },
    }
    start(session)
  })
}
