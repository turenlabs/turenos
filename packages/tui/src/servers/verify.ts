import { isRecord } from "../response-validation"
import { boundedText } from "../response-validation/body"
import { bypassLoopbackProxy } from "../server/proxy"
import { parseJSON } from "./text"
import { PasswordRequired, type AttachRecord, type Endpoint, type Target } from "./types"

/** Verification answers are small; a server that sends more than this is not answering as one. */
const VERIFY_BYTES = 64 * 1024

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

/** A record that names a serverID is only its owner's when the server answers with that same ID. */
async function sameServer(record: AttachRecord, signal: AbortSignal) {
  const response = await request(record, "/global/server", signal)
  if (!response?.ok) return false
  const body = parseJSON((await boundedText(response, VERIFY_BYTES)) ?? "")
  return isRecord(body) && body.serverID === record.serverID
}

function request(record: AttachRecord, path: string, signal: AbortSignal) {
  const address = new URL(path, record.url)
  // Verification runs before any Connection exists, so the loopback bypass must be installed here too.
  bypassLoopbackProxy(address)
  return fetch(address, {
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
  const text = response.ok ? await boundedText(response, VERIFY_BYTES) : undefined
  await response.body?.cancel().catch(() => {})
  const body = parseJSON(text ?? "")
  return {
    ok: response.ok && text !== undefined,
    status: response.status,
    version: isRecord(body) && typeof body.version === "string" ? body.version.slice(0, 64) : undefined,
  }
}
