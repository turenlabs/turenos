export type LobbyMember = {
  id: string
  type: "human" | "agent" | "system"
  name: string
  joined_at: string
}

export type LobbyRoom = {
  id: string
  name: string
  created_at: string
  deleted_at?: string
  head: number
  members: LobbyMember[]
}

export type LobbyPresence = {
  member_id: string
  member_type: "human" | "agent" | "system"
  state: "online" | "away"
  typing: boolean
  updated_at: string
  expires_at: string
}

export type LobbyPresenceSnapshot = {
  room_id: string
  version: number
  members: LobbyPresence[]
}

export type LobbyRoomProjection = {
  sequence: number
  room: LobbyRoom
}

export type LobbyEvent = {
  id: string
  room_id: string
  sequence: number
  actor_id: string
  actor_type: "human" | "agent" | "system"
  kind: string
  payload: unknown
  evidence_refs?: string[]
  base_revision: number
  created_at: string
}

export type LobbyMessage = {
  id: string
  room_id: string
  sequence: number
  actor_id: string
  actor_type: "human" | "agent" | "system"
  text: string
  reply_to?: string
  evidence_refs?: string[]
  base_revision: number
  created_at: string
}

export type LobbyPage<T> = {
  room: LobbyRoom
  has_more: boolean
  next_after: number
  items: T[]
}

export type LobbyDirectoryPage = {
  rooms: LobbyRoom[]
  has_more: boolean
  next_after: string
}

export type LobbyClient = {
  listRooms(after: string, limit: number, signal?: AbortSignal): Promise<LobbyDirectoryPage>
  createRoom(name: string, signal?: AbortSignal): Promise<LobbyRoom>
  updateRoom(roomID: string, input: LobbyRoomMutation, signal?: AbortSignal): Promise<LobbyRoom>
  deleteRoom(roomID: string, input: Omit<LobbyRoomMutation, "name">, signal?: AbortSignal): Promise<LobbyRoom>
  snapshot(roomID: string, signal?: AbortSignal): Promise<LobbyRoom>
  ledger(roomID: string, after: number, limit: number, signal?: AbortSignal): Promise<LobbyPage<LobbyEvent>>
  messages(roomID: string, after: number, limit: number, signal?: AbortSignal): Promise<LobbyPage<LobbyMessage>>
  stream(
    roomID: string,
    after: number,
    handlers: {
      open(): void
      message(message: LobbyMessage): void
      room?(projection: LobbyRoomProjection): void
      deleted?(projection: LobbyRoomProjection): void
      presence?(snapshot: LobbyPresenceSnapshot): void
      cursor?(sequence: number): void
    },
    signal?: AbortSignal,
  ): Promise<void>
  join(roomID: string, member: Omit<LobbyMember, "joined_at">, signal?: AbortSignal): Promise<LobbyRoom>
  leave(roomID: string, memberID: string, input: LobbyMemberMutation, signal?: AbortSignal): Promise<LobbyRoom>
  presence(roomID: string, signal?: AbortSignal): Promise<LobbyPresenceSnapshot>
  setPresence(
    roomID: string,
    input: { actor_id: string; actor_type: "human" | "agent"; state: "online" | "away" | "offline"; typing: boolean },
    signal?: AbortSignal,
  ): Promise<LobbyPresenceSnapshot>
  send(
    roomID: string,
    input: {
      actor_id: string
      actor_type: "human" | "agent" | "system"
      text: string
      reply_to?: string
      base_revision: number
      idempotency_key: string
    },
    signal?: AbortSignal,
  ): Promise<LobbyMessage>
}

export type LobbyRoomMutation = LobbyMemberMutation & { name: string }

export type LobbyMemberMutation = {
  actor_id: string
  actor_type: "human" | "agent"
  base_revision: number
  idempotency_key: string
}

const MAX_DIRECTORY_PAGES = 1_000
const MAX_HISTORY_PAGES = 100
const MAX_STREAM_FRAME_SIZE = 8 * 1024 * 1024

type LobbyClientOptions = {
  baseURL: string
  fetch?: typeof fetch
  diagnostic?(event: string, fields?: LobbyDiagnosticFields, level?: LobbyDiagnosticLevel): void
}

export class LobbyConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LobbyConfigurationError"
  }
}

export class LobbyDisabledError extends Error {
  constructor() {
    super("TurenOS lobby API URL is not configured.")
    this.name = "LobbyDisabledError"
  }
}

export class LobbyNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LobbyNetworkError"
  }
}

export class LobbyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = "LobbyRequestError"
  }
}

export class LobbyProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LobbyProtocolError"
  }
}

export function normalizeLobbyAPIURL(input: string) {
  const value = input.trim()
  if (!value) return ""
  if (/^https?:\/\/\//i.test(value)) throw new LobbyConfigurationError("Lobby API URL must include a hostname.")

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LobbyConfigurationError("Enter a valid HTTP(S) lobby API URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new LobbyConfigurationError("Lobby API URL must use http: or https:.")
  if (!url.hostname) throw new LobbyConfigurationError("Lobby API URL must include a hostname.")
  if (url.username || url.password) throw new LobbyConfigurationError("Lobby API URL must not include credentials.")
  if (url.search) throw new LobbyConfigurationError("Lobby API URL must not include a query string.")
  if (url.hash) throw new LobbyConfigurationError("Lobby API URL must not include a fragment.")
  if (url.pathname !== "/" && url.pathname !== "")
    throw new LobbyConfigurationError("Lobby API URL must not include a path.")
  return url.origin
}

export function lobbyRequestBaseURL(baseURL: string, development = import.meta.env.DEV) {
  if (!development) return baseURL
  if (baseURL !== "http://127.0.0.1:8787" && baseURL !== "http://localhost:8787") return baseURL
  return "/turen-lobby"
}

export function createLobbyClient(options: LobbyClientOptions): LobbyClient {
  const baseURL = normalizeLobbyAPIURL(options.baseURL)
  if (!baseURL) return disabledLobbyClient()
  const fetcher = options.fetch ?? fetch
  const requestBaseURL = lobbyRequestBaseURL(baseURL)
  const request = async <T>(path: string, parse: (value: unknown) => T, init: RequestInit = {}): Promise<T> => {
    const requestID = crypto.randomUUID()
    const method = init.method ?? "GET"
    const quiet = path.endsWith("/presence")
    const startedAt = performance.now()
    if (!quiet) options.diagnostic?.("client.request.started", { requestID, method, path })
    let response: Response
    try {
      response = await fetcher(`${requestBaseURL}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "X-Request-ID": requestID,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      })
    } catch (error) {
      options.diagnostic?.(
        "client.request.failed",
        {
          requestID,
          method,
          path,
          durationMs: Math.round(performance.now() - startedAt),
          ...lobbyDiagnosticError(error),
        },
        "error",
      )
      if (init.signal?.aborted) throw error
      throw new LobbyNetworkError(lobbyErrorMessage(error, "The configured lobby could not be reached."))
    }
    if (!quiet || !response.ok)
      options.diagnostic?.(
        response.ok ? "client.request.completed" : "client.request.rejected",
        {
          requestID,
          method,
          path,
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        },
        response.ok ? "info" : "warn",
      )

    let value: unknown
    let body: string
    try {
      body = await response.text()
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new LobbyNetworkError(lobbyErrorMessage(error, "The configured lobby could not be reached."))
    }
    if (body) {
      try {
        value = JSON.parse(body) as unknown
      } catch {
        if (response.ok) throw new LobbyProtocolError("The lobby returned malformed JSON.")
      }
    }
    if (!response.ok) {
      const error = parseLobbyError(value)
      throw new LobbyRequestError(
        response.status,
        error?.code,
        error?.message ?? `Lobby request failed with HTTP ${response.status}.`,
      )
    }
    init.signal?.throwIfAborted()
    if (value === undefined) throw new LobbyProtocolError("The lobby returned an empty JSON response.")
    return parse(value)
  }

  return {
    listRooms: (after, limit, signal) => {
      const query = new URLSearchParams({ limit: String(limit) })
      if (after) query.set("after", after)
      return request(`/rooms?${query}`, parseDirectoryPage, { signal })
    },
    createRoom: (name, signal) =>
      request("/rooms", parseRoom, { method: "POST", body: JSON.stringify({ name }), signal }),
    updateRoom: (roomID, input, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}`, parseRoom, {
        method: "PATCH",
        body: JSON.stringify(input),
        signal,
      }),
    deleteRoom: (roomID, input, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}`, parseRoom, {
        method: "DELETE",
        body: JSON.stringify(input),
        signal,
      }),
    snapshot: (roomID, signal) => request(`/rooms/${encodeURIComponent(roomID)}`, parseRoom, { signal }),
    ledger: (roomID, after, limit, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/ledger?after=${after}&limit=${limit}`, parseLedgerPage, { signal }),
    messages: (roomID, after, limit, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/messages?after=${after}&limit=${limit}`, parseMessagePage, {
        signal,
      }),
    stream: (roomID, after, handlers, signal) =>
      streamLobbyMessages(fetcher, requestBaseURL, roomID, after, handlers, signal, options.diagnostic),
    join: (roomID, member, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/members`, parseRoom, {
        method: "POST",
        body: JSON.stringify(member),
        signal,
      }),
    leave: (roomID, memberID, input, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/members/${encodeURIComponent(memberID)}`, parseRoom, {
        method: "DELETE",
        body: JSON.stringify(input),
        signal,
      }),
    presence: (roomID, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/presence`, parsePresenceSnapshot, { signal }),
    setPresence: (roomID, input, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/presence`, parsePresenceSnapshot, {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      }),
    send: (roomID, input, signal) =>
      request(`/rooms/${encodeURIComponent(roomID)}/messages`, parseMessage, {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      }),
  }
}

export type LobbyRoomHistory = {
  room: LobbyRoom
  events: LobbyEvent[]
  messages: LobbyMessage[]
  ledgerAfter: number
  messagesAfter: number
}

export async function loadLobbyDirectory(
  client: Pick<LobbyClient, "listRooms">,
  signal?: AbortSignal,
): Promise<LobbyRoom[]> {
  const rooms = new Map<string, LobbyRoom>()
  let after = ""

  for (let pageCount = 0; pageCount < MAX_DIRECTORY_PAGES; pageCount++) {
    const page = await client.listRooms(after, 100, signal)
    page.rooms.forEach((room) => rooms.set(room.id, room))
    if (!page.has_more) return [...rooms.values()].toSorted((left, right) => left.id.localeCompare(right.id))
    if (!page.next_after || page.next_after <= after)
      throw new LobbyProtocolError("The lobby returned a non-advancing room-directory cursor.")
    after = page.next_after
  }
  throw new LobbyProtocolError("The lobby directory exceeds the 100,000-room safety limit.")
}

export async function loadLobbyRoom(
  client: Pick<LobbyClient, "snapshot" | "ledger" | "messages">,
  roomID: string,
  signal?: AbortSignal,
): Promise<LobbyRoomHistory> {
  const room = await client.snapshot(roomID, signal)
  const [ledger, messages] = await Promise.all([
    collectLobbyPages((after) => client.ledger(roomID, after, 100, signal)),
    collectLobbyPages((after) => client.messages(roomID, after, 100, signal)),
  ])
  const latest = [room, ledger.room, messages.room].reduce((current, candidate) =>
    candidate.head > current.head ? candidate : current,
  )

  return {
    room: latest,
    events: ledger.items,
    messages: mergeLobbyMessages([], messages.items),
    ledgerAfter: ledger.after,
    messagesAfter: messages.after,
  }
}

export function mergeLobbyMessages(current: readonly LobbyMessage[], incoming: readonly LobbyMessage[]) {
  const messages = new Map(current.map((message) => [message.id, message] as const))
  incoming.forEach((message) => messages.set(message.id, message))
  return [...messages.values()].toSorted((left, right) => left.sequence - right.sequence)
}

export function isLobbyNetworkError(error: unknown) {
  return error instanceof LobbyNetworkError
}

export function isLobbyRevisionConflict(error: unknown) {
  return error instanceof LobbyRequestError && error.status === 409 && error.code === "revision_conflict"
}

export function lobbyErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  if (!isRecord(error)) return fallback
  if (typeof error.message === "string" && error.message.trim()) return error.message
  if (typeof error.error === "string" && error.error.trim()) return error.error
  return fallback
}

async function streamLobbyMessages(
  fetcher: typeof fetch,
  baseURL: string,
  roomID: string,
  after: number,
  handlers: {
    open(): void
    message(message: LobbyMessage): void
    room?(projection: LobbyRoomProjection): void
    deleted?(projection: LobbyRoomProjection): void
    presence?(snapshot: LobbyPresenceSnapshot): void
    cursor?(sequence: number): void
  },
  signal?: AbortSignal,
  diagnostic?: (event: string, fields?: LobbyDiagnosticFields, level?: LobbyDiagnosticLevel) => void,
) {
  const requestID = crypto.randomUUID()
  let response: Response
  try {
    response = await fetcher(`${baseURL}/rooms/${encodeURIComponent(roomID)}/stream?after=${after}`, {
      headers: { Accept: "text/event-stream", "X-Request-ID": requestID },
      signal,
    })
  } catch (error) {
    diagnostic?.("client.stream.failed", { requestID, roomID, cursor: after, ...lobbyDiagnosticError(error) }, "error")
    if (signal?.aborted) throw error
    throw new LobbyNetworkError(lobbyErrorMessage(error, "The lobby stream could not be reached."))
  }
  diagnostic?.(
    response.ok ? "client.stream.connected" : "client.stream.rejected",
    { requestID, roomID, cursor: after, httpStatus: response.status },
    response.ok ? "info" : "warn",
  )
  if (!response.ok) {
    const body = await response.text()
    let value: unknown
    try {
      value = body ? (JSON.parse(body) as unknown) : undefined
    } catch {
      value = undefined
    }
    const error = parseLobbyError(value)
    throw new LobbyRequestError(
      response.status,
      error?.code,
      error?.message ?? `Lobby stream failed with HTTP ${response.status}.`,
    )
  }
  if (!response.body) throw new LobbyProtocolError("The lobby returned an empty event stream.")
  handlers.open()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch (error) {
      if (signal?.aborted) throw error
      throw new LobbyNetworkError(lobbyErrorMessage(error, "The lobby stream disconnected."))
    }
    buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replaceAll("\r\n", "\n")
    for (;;) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary === -1) break
      if (boundary > MAX_STREAM_FRAME_SIZE)
        throw new LobbyProtocolError("The lobby stream returned an oversized event.")
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      const event =
        frame
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "chat.message"
      let value: unknown
      try {
        value = JSON.parse(data) as unknown
      } catch {
        throw new LobbyProtocolError("The lobby stream returned malformed JSON.")
      }
      if (event === "chat.message") handlers.message(parseMessage(value))
      else if (event === "room.updated") handlers.room?.(parseRoomProjection(value))
      else if (event === "room.deleted") handlers.deleted?.(parseRoomProjection(value))
      else if (event === "presence.snapshot") handlers.presence?.(parsePresenceSnapshot(value))
      else if (event === "ledger.cursor") handlers.cursor?.(parseCursor(value))
    }
    if (buffer.length > MAX_STREAM_FRAME_SIZE)
      throw new LobbyProtocolError("The lobby stream returned an oversized event.")
    if (chunk.done) return
  }
}

function disabledLobbyClient(): LobbyClient {
  const disabled = <T>() => Promise.reject<T>(new LobbyDisabledError())
  return {
    listRooms: disabled,
    createRoom: disabled,
    updateRoom: disabled,
    deleteRoom: disabled,
    snapshot: disabled,
    ledger: disabled,
    messages: disabled,
    stream: disabled,
    join: disabled,
    leave: disabled,
    presence: disabled,
    setPresence: disabled,
    send: disabled,
  }
}

function parseDirectoryPage(value: unknown): LobbyDirectoryPage {
  if (!isRecord(value) || !Array.isArray(value.rooms) || !value.rooms.every(isLobbyRoom))
    throw new LobbyProtocolError("The lobby returned an invalid room directory.")
  if (typeof value.next_after !== "string" || typeof value.has_more !== "boolean")
    throw new LobbyProtocolError("The lobby returned an invalid room-directory cursor.")
  return { rooms: value.rooms, next_after: value.next_after, has_more: value.has_more }
}

function parseLedgerPage(value: unknown): LobbyPage<LobbyEvent> {
  if (!isRecord(value) || !isLobbyRoom(value.room) || !Array.isArray(value.events) || !value.events.every(isLobbyEvent))
    throw new LobbyProtocolError("The lobby returned an invalid ledger page.")
  return parsePage(value, value.events)
}

function parseMessagePage(value: unknown): LobbyPage<LobbyMessage> {
  if (
    !isRecord(value) ||
    !isLobbyRoom(value.room) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isLobbyMessage)
  )
    throw new LobbyProtocolError("The lobby returned an invalid message page.")
  return parsePage(value, value.messages)
}

function parsePage<T>(value: Record<string, unknown>, items: T[]): LobbyPage<T> {
  if (!isLobbyRoom(value.room) || typeof value.has_more !== "boolean" || !isNonNegativeInteger(value.next_after))
    throw new LobbyProtocolError("The lobby returned an invalid page cursor.")
  return { room: value.room, items, has_more: value.has_more, next_after: value.next_after }
}

function parseRoom(value: unknown): LobbyRoom {
  if (!isLobbyRoom(value)) throw new LobbyProtocolError("The lobby returned an invalid room snapshot.")
  return value
}

function parseRoomProjection(value: unknown): LobbyRoomProjection {
  if (!isRecord(value) || !isNonNegativeInteger(value.sequence) || !isLobbyRoom(value.room))
    throw new LobbyProtocolError("The lobby returned an invalid room stream event.")
  return { sequence: value.sequence, room: value.room }
}

function parsePresenceSnapshot(value: unknown): LobbyPresenceSnapshot {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.room_id) ||
    !isNonNegativeInteger(value.version) ||
    !Array.isArray(value.members) ||
    !value.members.every(isLobbyPresence)
  )
    throw new LobbyProtocolError("The lobby returned invalid presence state.")
  return { room_id: value.room_id, version: value.version, members: value.members }
}

function parseCursor(value: unknown) {
  if (!isRecord(value) || !isNonNegativeInteger(value.sequence))
    throw new LobbyProtocolError("The lobby returned an invalid ledger cursor event.")
  return value.sequence
}

function parseMessage(value: unknown): LobbyMessage {
  if (!isLobbyMessage(value)) throw new LobbyProtocolError("The lobby returned an invalid chat message.")
  return value
}

function parseLobbyError(value: unknown) {
  if (!isRecord(value)) return
  const code = typeof value.error === "string" ? value.error : undefined
  const message = typeof value.message === "string" ? value.message : undefined
  if (!code && !message) return
  return { code, message }
}

function isLobbyRoom(value: unknown): value is LobbyRoom {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    typeof value.created_at === "string" &&
    (value.deleted_at === undefined || typeof value.deleted_at === "string") &&
    isNonNegativeInteger(value.head) &&
    Array.isArray(value.members) &&
    value.members.every(isLobbyMember)
  )
}

function isLobbyPresence(value: unknown): value is LobbyPresence {
  return (
    isRecord(value) &&
    isNonEmptyString(value.member_id) &&
    isActorType(value.member_type) &&
    (value.state === "online" || value.state === "away") &&
    typeof value.typing === "boolean" &&
    typeof value.updated_at === "string" &&
    typeof value.expires_at === "string"
  )
}

function isLobbyMember(value: unknown): value is LobbyMember {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isActorType(value.type) &&
    isNonEmptyString(value.name) &&
    typeof value.joined_at === "string"
  )
}

function isLobbyEvent(value: unknown): value is LobbyEvent {
  return (
    isRecord(value) &&
    isCommonEvent(value) &&
    isNonEmptyString(value.kind) &&
    "payload" in value &&
    (value.evidence_refs === undefined || isStringArray(value.evidence_refs))
  )
}

function isLobbyMessage(value: unknown): value is LobbyMessage {
  return (
    isRecord(value) &&
    isCommonEvent(value) &&
    isNonEmptyString(value.text) &&
    (value.reply_to === undefined || typeof value.reply_to === "string") &&
    (value.evidence_refs === undefined || isStringArray(value.evidence_refs))
  )
}

function isCommonEvent(value: Record<string, unknown>) {
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.room_id) &&
    isNonNegativeInteger(value.sequence) &&
    isNonEmptyString(value.actor_id) &&
    isActorType(value.actor_type) &&
    isNonNegativeInteger(value.base_revision) &&
    typeof value.created_at === "string"
  )
}

function isActorType(value: unknown): value is LobbyMember["type"] {
  return value === "human" || value === "agent" || value === "system"
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function collectLobbyPages<T>(load: (after: number) => Promise<LobbyPage<T>>) {
  let after = 0
  let room: LobbyRoom | undefined
  const items: T[] = []

  for (let pageCount = 0; pageCount < MAX_HISTORY_PAGES; pageCount++) {
    const page = await load(after)
    room = page.room
    items.push(...page.items)
    if (!page.has_more) return { room: room!, items, after: page.next_after }
    if (!Number.isSafeInteger(page.next_after) || page.next_after <= after)
      throw new LobbyProtocolError("The lobby returned a non-advancing history cursor.")
    after = page.next_after
  }
  throw new LobbyProtocolError("The lobby returned too many history pages.")
}
import { lobbyDiagnosticError, type LobbyDiagnosticFields, type LobbyDiagnosticLevel } from "./lobby-diagnostics"
