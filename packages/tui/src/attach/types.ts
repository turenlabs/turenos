import type { Api } from "../api"

/** Ctrl+], as in telnet and `docker attach`: a key shells and editors leave alone. */
export const DETACH = 0x1d

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
  /** Input typed while disconnected, in order, and its size in bytes. */
  pending: { text: string[]; bytes: number }
  resolve: (result: AttachResult) => void
  /** Registered on stdin and stdout while attached, and released in finish(). */
  listeners: { keystrokes: (chunk: Buffer | string) => void; resized: () => void }
}
