import { parseJSON } from "../api"
import { isRecord, object, string } from "../response-validation"
import { DETACH, type AttachResult, type Session } from "./types"

export function start(session: Session) {
  session.options.stdin.on("data", session.listeners.keystrokes)
  session.options.stdout.on("resize", session.listeners.resized)
  void connect(session)
}

export function finish(session: Session, result: AttachResult) {
  if (session.finished) return
  session.finished = true
  session.options.stdin.off("data", session.listeners.keystrokes)
  session.options.stdout.off("resize", session.listeners.resized)
  session.socket?.close(1000)
  session.resolve(result)
}

export function keystrokes(session: Session, chunk: Buffer | string) {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
  const stop = bytes.indexOf(DETACH)
  const text = session.decoder.decode(stop < 0 ? bytes : bytes.subarray(0, stop), { stream: stop < 0 })
  if (text && session.socket?.readyState === WebSocket.OPEN) session.socket.send(text)
  if (stop >= 0) finish(session, { reason: "detached" })
}

export function resized(session: Session) {
  const rows = session.options.stdout.rows
  const cols = session.options.stdout.columns
  if (rows && cols) void session.options.resize({ rows, cols }).catch(() => undefined)
}

function receive(session: Session, data: string | ArrayBuffer) {
  if (typeof data === "string") {
    session.options.stdout.write(data)
    session.cursor = (session.cursor ?? 0) + data.length
    return
  }
  // After the replay the server sends one control frame: a zero byte, then {"cursor":N}.
  const bytes = new Uint8Array(data)
  if (bytes[0] !== 0) return
  const meta = parseJSON(new TextDecoder().decode(bytes.subarray(1)))
  if (isRecord(meta) && Number.isSafeInteger(meta.cursor)) session.cursor = meta.cursor as number
}

function closed(session: Session, current: WebSocket, code: number) {
  if (session.finished || session.socket !== current) return
  // 1000: the PTY exited or was removed; 4404: it ended while this client connected.
  if (code === 1000 || code === 4404) return finish(session, { reason: "exited" })
  if (++session.attempts > 5) return finish(session, { reason: "failed", detail: `Connection closed (${code}).` })
  setTimeout(() => void connect(session), Math.min(250 * 2 ** session.attempts, 4000))
}

async function connect(session: Session) {
  const ticket = await mint(session).catch((error: unknown) => {
    finish(session, { reason: "failed", detail: error instanceof Error ? error.message : String(error) })
    return undefined
  })
  if (!ticket || session.finished) return
  const address = new URL(`/api/pty/${encodeURIComponent(session.options.target.id)}/connect`, session.options.url)
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:"
  for (const [key, value] of Object.entries(session.location)) address.searchParams.set(key, value)
  if (session.cursor !== undefined) address.searchParams.set("cursor", String(session.cursor))
  address.searchParams.set("ticket", ticket)
  const current = session.open(address.href)
  session.socket = current
  current.binaryType = "arraybuffer"
  current.onopen = () => {
    session.attempts = 0
    resized(session)
  }
  current.onmessage = (event) => receive(session, event.data as string | ArrayBuffer)
  current.onclose = (event) => closed(session, current, event.code)
}

async function mint(session: Session) {
  const response = object(
    await session.options.api(`/api/pty/${encodeURIComponent(session.options.target.id)}/connect-token`, {
      method: "POST",
      query: session.location,
      headers: { "x-forge-ticket": "1" },
    }),
  )
  return string(object(response.data).ticket, 256)
}
