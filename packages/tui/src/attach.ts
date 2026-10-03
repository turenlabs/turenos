import { parseJSON, type Api } from "./api"
import { identifier, isRecord, object, string } from "./response-validation"

/** Ctrl+], as in telnet and `docker attach`: a key shells and editors leave alone. */
export const DETACH = 0x1d

export type AttachTarget = { id: string; title: string; directory: string; workspace?: string }

type Input = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
}
type Output = {
  write(text: string): unknown
  columns?: number
  rows?: number
  on(event: "resize", listener: () => void): unknown
  off(event: "resize", listener: () => void): unknown
}

/**
 * Joins this terminal to a server PTY, the way the desktop's terminal pane does: a single-use
 * ticket opens the PTY's WebSocket, output replays and then streams, keystrokes go back as text,
 * and the size follows this terminal. Resolves when Ctrl+] detaches or the PTY ends.
 */
export function attachTerminal(input: {
  url: URL
  api: Api
  resize: (size: { rows: number; cols: number }) => Promise<unknown>
  target: AttachTarget
  stdin: Input
  stdout: Output
  socket?: (url: string) => WebSocket
}): Promise<{ reason: "detached" | "exited" | "failed"; detail?: string }> {
  const target = input.target
  identifier(target.id, "pty_")
  const open = input.socket ?? ((url: string) => new WebSocket(url))
  const decoder = new TextDecoder("utf-8")
  const location = {
    "location[directory]": target.directory,
    ...(target.workspace ? { "location[workspace]": target.workspace } : {}),
  }
  let cursor: number | undefined
  let socket: WebSocket | undefined
  let finished = false
  let attempts = 0

  return new Promise((resolve) => {
    function finish(result: { reason: "detached" | "exited" | "failed"; detail?: string }) {
      if (finished) return
      finished = true
      input.stdin.off("data", keystrokes)
      input.stdout.off("resize", resized)
      socket?.close(1000)
      resolve(result)
    }

    function keystrokes(chunk: Buffer | string) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      const stop = bytes.indexOf(DETACH)
      const text = decoder.decode(stop < 0 ? bytes : bytes.subarray(0, stop), { stream: stop < 0 })
      if (text && socket?.readyState === WebSocket.OPEN) socket.send(text)
      if (stop >= 0) finish({ reason: "detached" })
    }

    function resized() {
      const rows = input.stdout.rows
      const cols = input.stdout.columns
      if (rows && cols) void input.resize({ rows, cols }).catch(() => undefined)
    }

    function receive(data: string | ArrayBuffer) {
      if (typeof data === "string") {
        input.stdout.write(data)
        cursor = (cursor ?? 0) + data.length
        return
      }
      // After the replay the server sends one control frame: a zero byte, then {"cursor":N}.
      const bytes = new Uint8Array(data)
      if (bytes[0] !== 0) return
      const meta = parseJSON(new TextDecoder().decode(bytes.subarray(1)))
      if (isRecord(meta) && Number.isSafeInteger(meta.cursor)) cursor = meta.cursor as number
    }

    function closed(current: WebSocket, code: number) {
      if (finished || socket !== current) return
      // 1000: the PTY exited or was removed; 4404: it ended while this client connected.
      if (code === 1000 || code === 4404) return finish({ reason: "exited" })
      if (++attempts > 5) return finish({ reason: "failed", detail: `Connection closed (${code}).` })
      setTimeout(() => void connect(), Math.min(250 * 2 ** attempts, 4000))
    }

    async function connect() {
      const ticket = await mint().catch((error: unknown) => {
        finish({ reason: "failed", detail: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      if (!ticket || finished) return
      const address = new URL(`/api/pty/${encodeURIComponent(target.id)}/connect`, input.url)
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:"
      for (const [key, value] of Object.entries(location)) address.searchParams.set(key, value)
      if (cursor !== undefined) address.searchParams.set("cursor", String(cursor))
      address.searchParams.set("ticket", ticket)
      const current = open(address.href)
      socket = current
      current.binaryType = "arraybuffer"
      current.onopen = () => {
        attempts = 0
        resized()
      }
      current.onmessage = (event) => receive(event.data as string | ArrayBuffer)
      current.onclose = (event) => closed(current, event.code)
    }

    async function mint() {
      const response = object(
        await input.api(`/api/pty/${encodeURIComponent(target.id)}/connect-token`, {
          method: "POST",
          query: location,
          headers: { "x-forge-ticket": "1" },
        }),
      )
      return string(object(response.data).ticket, 256)
    }

    input.stdin.on("data", keystrokes)
    input.stdout.on("resize", resized)
    void connect()
  })
}
