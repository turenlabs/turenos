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
  return {
    target,
    url: record.url,
    username: record.username,
    password: record.password || undefined,
    version: result.version,
    close,
  }
}

async function health(record: AttachRecord, signal: AbortSignal) {
  const response = await fetch(new URL("/global/health", record.url), {
    headers: record.password
      ? { Authorization: `Basic ${Buffer.from(`${record.username}:${record.password}`).toString("base64")}` }
      : {},
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  }).catch(() => undefined)
  if (!response) return { ok: false, status: 0 }
  const body = response.ok ? parseJSON((await response.text()).slice(0, 65536)) : undefined
  await response.body?.cancel().catch(() => {})
  return {
    ok: response.ok,
    status: response.status,
    version: isRecord(body) && typeof body.version === "string" ? body.version.slice(0, 64) : undefined,
  }
}
