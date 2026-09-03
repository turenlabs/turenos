export type LobbyDiagnosticLevel = "info" | "warn" | "error"

export type LobbyDiagnosticEntry = {
  at: string
  event: string
  level: LobbyDiagnosticLevel
  roomID?: string
  instanceID?: string
  sessionID?: string
  sequence?: number
  promptID?: string
  responseKey?: string
  phase?: string
  status?: string
  fromStatus?: string
  toStatus?: string
  attempt?: number
  cursor?: number
  revision?: number
  resultSequence?: number
  queueDepth?: number
  eventCount?: number
  presenceVersion?: number
  memberCount?: number
  durationMs?: number
  waitMs?: number
  textLength?: number
  errorName?: string
  errorStatus?: number
  errorCode?: string
  requestID?: string
  method?: string
  path?: string
  httpStatus?: number
}

export type LobbyDiagnosticFields = Omit<LobbyDiagnosticEntry, "at" | "event" | "level">

type Listener = (entries: readonly LobbyDiagnosticEntry[]) => void

const limit = 300
const entries: LobbyDiagnosticEntry[] = []
const listeners = new Set<Listener>()

export function lobbyDiagnostic(
  event: string,
  fields: LobbyDiagnosticFields = {},
  level: LobbyDiagnosticLevel = "info",
) {
  const entry = { at: new Date().toISOString(), event, level, ...fields }
  entries.push(entry)
  if (entries.length > limit) entries.splice(0, entries.length - limit)
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.info
  method("[lobby]", JSON.stringify(entry))
  listeners.forEach((listener) => listener(entries))
}

export function lobbyDiagnosticError(error: unknown) {
  if (!error || typeof error !== "object") return { errorName: typeof error }
  return {
    errorName: error instanceof Error ? error.name : error.constructor?.name,
    errorStatus: numericField(error, "status") ?? nestedNumericField(error, "cause", "status"),
    errorCode: stringField(error, "code") ?? nestedStringField(error, "cause", "code"),
  }
}

export function lobbyDiagnosticsSnapshot() {
  return entries.slice()
}

export function subscribeLobbyDiagnostics(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function numericField(value: object, key: string) {
  if (!(key in value)) return
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "number" ? field : undefined
}

function stringField(value: object, key: string) {
  if (!(key in value)) return
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : undefined
}

function nestedNumericField(value: object, parent: string, key: string) {
  if (!(parent in value)) return
  const nested = (value as Record<string, unknown>)[parent]
  return nested && typeof nested === "object" ? numericField(nested, key) : undefined
}

function nestedStringField(value: object, parent: string, key: string) {
  if (!(parent in value)) return
  const nested = (value as Record<string, unknown>)[parent]
  return nested && typeof nested === "object" ? stringField(nested, key) : undefined
}
