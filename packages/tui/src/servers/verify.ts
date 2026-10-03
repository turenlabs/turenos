import { isRecord } from "../response-validation"
import { parseJSON } from "./text"
import { PasswordRequired, type AttachRecord, type Endpoint, type Target } from "./types"

/** Proves the credentials against the server before any dashboard is built on them. */
export async function verified(
  target: Target,
  record: AttachRecord,
  signal: AbortSignal,
  unreachable: string,
  close?: () => void,
): Promise<Endpoint> {
  const result = await health(record, signal)
  if (result.status === 401 || result.status === 403) {
    close?.()
    if (target.kind === "url") throw new PasswordRequired(target)
    if (target.kind === "env") throw new Error("The server on 127.0.0.1:4096 rejected FORGE_SERVER_PASSWORD.")
    throw new Error(`${target.name} rejected its published credentials. Restart it, then try again.`)
  }
  if (!result.ok) {
    close?.()
    throw new Error(unreachable)
  }
  if (record.serverID && !(await sameServer(record, signal))) {
    close?.()
    throw new Error(`${target.name} is not the server that published this record. Restart it, then try again.`)
  }
  return {
    target,
    url: record.url,
    username: record.username,
    password: record.password || undefined,
    version: result.version,
    close,
  }
}

/**
 * Servers that publish `GET /global/server` name themselves; a 404 is a server that predates it, with
 * nothing to compare. Any other answer that does not carry the record's serverID is refused.
 */
async function sameServer(record: AttachRecord, signal: AbortSignal) {
  const response = await request(record, "/global/server", signal)
  if (response?.status === 404) return true
  if (!response?.ok) return false
  const body = parseJSON((await response.text()).slice(0, 65536))
  return isRecord(body) && body.serverID === record.serverID
}

function request(record: AttachRecord, path: string, signal: AbortSignal) {
  return fetch(new URL(path, record.url), {
    headers: record.password
      ? { Authorization: `Basic ${Buffer.from(`${record.username}:${record.password}`).toString("base64")}` }
      : {},
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  }).catch(() => undefined)
}

async function health(record: AttachRecord, signal: AbortSignal) {
  const response = await request(record, "/global/health", signal)
  if (!response) return { ok: false, status: 0 }
  const body = response.ok ? parseJSON((await response.text()).slice(0, 65536)) : undefined
  await response.body?.cancel().catch(() => {})
  return {
    ok: response.ok,
    status: response.status,
    version: isRecord(body) && typeof body.version === "string" ? body.version.slice(0, 64) : undefined,
  }
}
