import { parseJSON } from "../api"
import { isRecord, object, string } from "../response-validation"
import { DETACH, DETACH_SEQUENCES, PENDING_LIMIT, RESTORE, type AttachResult, type Session } from "./types"

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
  // Whatever the PTY's programs left switched on must not outlive the attachment.
  session.options.stdout.write(RESTORE)
  session.socket?.close(1000)
  session.resolve(result)
}

export function keystrokes(session: Session, chunk: Buffer | string) {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
  const found = [DETACH, ...DETACH_SEQUENCES].map((key) => bytes.indexOf(key)).filter((index) => index >= 0)
  const stop = found.length ? Math.min(...found) : -1
  const text = session.decoder.decode(stop < 0 ? bytes : bytes.subarray(0, stop), { stream: stop < 0 })
  if (text) send(session, text)
  if (stop >= 0) finish(session, { reason: "detached" })
}

function send(session: Session, text: string) {
  if (session.socket?.readyState === WebSocket.OPEN) return session.socket.send(text)
  // Reconnecting: keep what was typed, up to the limit. Past it, everything that follows is dropped too, so
  // what does arrive is a prefix of what was typed and never fragments out of order.
  const bytes = Buffer.byteLength(text)
  if (session.pending.overflow || session.pending.bytes + bytes > PENDING_LIMIT) {
    session.pending.overflow = true
    return
  }
  session.pending.text.push(text)
  session.pending.bytes += bytes
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
  // A connection that lived a while earns fresh attempts; one the server drops at once does not.
  if (session.openedAt !== undefined && Date.now() - session.openedAt > 5000) session.attempts = 0
  retry(session, `Connection closed (${code}).`)
}

function retry(session: Session, detail: string) {
  if (++session.attempts > 5) return finish(session, { reason: "failed", detail })
  setTimeout(() => void connect(session), Math.min(250 * 2 ** session.attempts, 4000))
}

/** A server that is restarting answers again shortly; a definite refusal does not. */
function transient(detail: string) {
  return /^(The server did not answer in time|Connection failed|Server returned HTTP 5\d\d\b)/.test(detail)
}

async function connect(session: Session) {
  if (session.finished) return
  const ticket = await mint(session).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    // A 404 means the PTY was removed while this client was disconnected: there is nothing to reconnect to.
    if (/^Server returned HTTP 404\b/.test(detail)) finish(session, { reason: "exited" })
    else if (transient(detail)) retry(session, detail)
    else finish(session, { reason: "failed", detail })
    return undefined
  })
  if (!ticket || session.finished) return
  const address = new URL(`/api/pty/${encodeURIComponent(session.options.target.id)}/connect`, session.options.url)
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:"
  for (const [key, value] of Object.entries(session.location)) address.searchParams.set(key, value)
  if (session.cursor !== undefined) address.searchParams.set("cursor", String(session.cursor))
  address.searchParams.set("ticket", ticket)
  const current = opened(session, address.href)
  if (!current) return
  session.socket = current
  current.binaryType = "arraybuffer"
  current.onopen = () => {
    session.openedAt = Date.now()
    resized(session)
    session.pending.text.splice(0).forEach((text) => current.send(text))
    session.pending.bytes = 0
    session.pending.overflow = false
  }
  current.onmessage = (event) => {
    if (!session.finished) receive(session, event.data as string | ArrayBuffer)
  }
  current.onclose = (event) => closed(session, current, event.code)
}

/** A socket the constructor refused (a bad address, no network) is a connection failure, never an unhandled rejection. */
function opened(session: Session, href: string) {
  try {
    return session.open(href)
  } catch {
    retry(session, "Connection failed.")
    return undefined
  }
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
