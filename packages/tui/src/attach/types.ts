import type { Api } from "../api"

/** Ctrl+], as in telnet and `docker attach`: a key shells and editors leave alone. */
export const DETACH = 0x1d

/** Ctrl+] as the kitty keyboard protocol and modifyOtherKeys encode it, once a PTY program turned those on. */
export const DETACH_SEQUENCES = ["\x1b[93;5u", "\x1b[27;5;93~"]

/**
 * Written when the attachment ends: a soft reset, ASCII charset, full scroll region, no origin
 * mode, autowrap on, normal cursor keys, kitty keyboard flags off, default palette and colours,
 * and no open hyperlink. A PTY program may have changed any of them, and the dashboard repaints
 * on top.
 */
export const RESTORE =
  "\x1b[!p\x1b(B\x1b[r\x1b[?6l\x1b[?7h\x1b[?1l\x1b[=0;1u\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]8;;\x1b\\"

/** Keystrokes typed while the socket is down wait for the reconnect, up to this many bytes. */
export const PENDING_LIMIT = 64 * 1024

export type AttachTarget = { id: string; title: string; directory: string; workspace?: string }

export type Input = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
}
export type Output = {
  write(text: string): unknown
  columns?: number
  rows?: number
  on(event: "resize", listener: () => void): unknown
  off(event: "resize", listener: () => void): unknown
}

export type AttachOptions = {
  url: URL
  api: Api
  resize: (size: { rows: number; cols: number }) => Promise<unknown>
  target: AttachTarget
  stdin: Input
  stdout: Output
  socket?: (url: string) => WebSocket
}

export type AttachResult = { reason: "detached" | "exited" | "failed"; detail?: string }

/** One attachment's state: the socket, how much output has been seen, and how often it reconnected. */
export type Session = {
  options: AttachOptions
  open: (url: string) => WebSocket
  decoder: TextDecoder
  location: Record<string, string>
  cursor: number | undefined
  socket: WebSocket | undefined
  finished: boolean
  attempts: number
  /** When the current socket opened; a connection that lived a while earns fresh attempts. */
  openedAt: number | undefined
  /** Input typed while disconnected, in order, and its size in bytes; past the limit, everything after is dropped. */
  pending: { text: string[]; bytes: number; overflow: boolean }
  resolve: (result: AttachResult) => void
  /** Registered on stdin and stdout while attached, and released in finish(). */
  listeners: { keystrokes: (chunk: Buffer | string) => void; resized: () => void }
}
