import { expect, test, mock, beforeEach } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  BATOU_VERSION,
  batouBinaryPath,
  batouCacheDir,
  batouDownloadUrl,
  batouInstalled,
  batouPlatform,
  batouStatus,
  beginBatouDownload,
  ensureBatouBinary,
  resolveBatouBinary,
  resetBatouDownloadState,
} from "@/security/batou-binary"

/** Flush microtasks + the mocked fetch resolution so the single-flight run settles. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** PATH empty so which() never resolves a batou that happens to be installed on the dev box. */
const NO_PATH: NodeJS.ProcessEnv = { PATH: "" }

function jsonResponse(body: Uint8Array, status = 200): Response {
  return new Response(body as unknown as BodyInit, { status })
}

beforeEach(async () => {
  resetBatouDownloadState()
  await fs.rm(batouCacheDir(), { recursive: true, force: true })
})

test("batouPlatform maps supported targets and rejects the rest", () => {
  expect(batouPlatform("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" })
  expect(batouPlatform("darwin", "x64")).toEqual({ os: "darwin", arch: "amd64" })
  expect(batouPlatform("linux", "arm64")).toEqual({ os: "linux", arch: "arm64" })
  expect(batouPlatform("linux", "x64")).toEqual({ os: "linux", arch: "amd64" })
  expect(batouPlatform("win32", "x64")).toBeUndefined()
  expect(batouPlatform("darwin", "ia32")).toBeUndefined()
})

test("batouDownloadUrl targets the pinned release asset", () => {
  expect(batouDownloadUrl({ os: "linux", arch: "amd64" })).toBe(
    "https://github.com/turenlabs/batou/releases/download/v2.0.0/batou-linux-amd64",
  )
})

test("resolveBatouBinary / batouInstalled report false with no binary present", async () => {
  expect(await resolveBatouBinary(NO_PATH)).toBeUndefined()
  expect(await batouInstalled(NO_PATH)).toBe(false)
})

test("resolveBatouBinary finds a cached binary and installed reports true", async () => {
  await fs.mkdir(batouCacheDir(), { recursive: true })
  await fs.writeFile(batouBinaryPath(), "#!/bin/sh\n", { mode: 0o700 })
  expect(await resolveBatouBinary(NO_PATH)).toBe(batouBinaryPath())
  expect(await batouInstalled(NO_PATH)).toBe(true)
})

test("ensureBatouBinary is a no-op on unsupported platforms and never fetches", async () => {
  const fetchImpl = mock(async () => jsonResponse(new Uint8Array()))
  const result = await ensureBatouBinary({
    env: NO_PATH,
    platform: "win32",
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  expect(result).toBeUndefined()
  expect(fetchImpl).toHaveBeenCalledTimes(0)
})

test("ensureBatouBinary rejects a checksum mismatch and leaves nothing behind", async () => {
  const fetchImpl = mock(async () => jsonResponse(new TextEncoder().encode("not the real batou binary")))
  const logs: string[] = []
  const result = await ensureBatouBinary({
    env: NO_PATH,
    platform: "linux",
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: (m) => logs.push(m),
  })
  expect(result).toBeUndefined()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(logs.some((m) => m.includes("checksum mismatch"))).toBe(true)
  // No binary and no stray temp download left in the cache dir.
  expect(await resolveBatouBinary(NO_PATH)).toBeUndefined()
  const leftovers = await fs.readdir(batouCacheDir()).catch(() => [])
  expect(leftovers).toEqual([])
})

test("ensureBatouBinary returns undefined (not throws) on a failed HTTP fetch", async () => {
  const fetchImpl = mock(async () => jsonResponse(new Uint8Array(), 404))
  const result = await ensureBatouBinary({
    env: NO_PATH,
    platform: "linux",
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  expect(result).toBeUndefined()
})

test("ensureBatouBinary single-flights concurrent downloads", async () => {
  let calls = 0
  const fetchImpl = mock(async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return jsonResponse(new TextEncoder().encode("mismatch"))
  })
  const opts = {
    env: NO_PATH,
    platform: "linux" as const,
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: () => {},
  }
  const [a, b] = await Promise.all([ensureBatouBinary(opts), ensureBatouBinary(opts)])
  expect(a).toBeUndefined()
  expect(b).toBeUndefined()
  expect(calls).toBe(1)
})

test("ensureBatouBinary short-circuits to the cached binary without fetching", async () => {
  await fs.mkdir(batouCacheDir(), { recursive: true })
  await fs.writeFile(batouBinaryPath(), "#!/bin/sh\n", { mode: 0o700 })
  const fetchImpl = mock(async () => jsonResponse(new Uint8Array()))
  const result = await ensureBatouBinary({
    env: NO_PATH,
    platform: "linux",
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  expect(result).toBe(batouBinaryPath())
  expect(fetchImpl).toHaveBeenCalledTimes(0)
})

test("the cached binary lives under <cache>/security/batou/batou", () => {
  expect(batouBinaryPath()).toBe(path.join(batouCacheDir(), "batou"))
  expect(batouCacheDir().endsWith(path.join("security", "batou"))).toBe(true)
})

test("batouStatus reports not-installed when no binary is present and nothing is in flight", async () => {
  expect(await batouStatus(NO_PATH)).toEqual({ status: "not-installed" })
})

test("batouStatus reports installed with the pinned version for a cached binary", async () => {
  await fs.mkdir(batouCacheDir(), { recursive: true })
  await fs.writeFile(batouBinaryPath(), "#!/bin/sh\n", { mode: 0o700 })
  expect(await batouStatus(NO_PATH)).toEqual({ status: "installed", detail: BATOU_VERSION })
})

test("batouStatus walks downloading → failed with a sanitized reason, then backs off", async () => {
  let release: (response: Response) => void = () => {}
  const gate = new Promise<Response>((resolve) => (release = resolve))
  const fetchImpl = mock(() => gate)
  const opts = {
    env: NO_PATH,
    platform: "linux" as const,
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: () => {},
  }

  const pending = ensureBatouBinary(opts)
  await settle() // let ensure reach the awaited fetch so `inflight` is set.
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  // Mid-flight the row shows "downloading" (no detail — nothing to say yet).
  expect(await batouStatus(NO_PATH)).toEqual({ status: "downloading" })

  release(jsonResponse(new TextEncoder().encode("not the real batou binary")))
  expect(await pending).toBeUndefined()
  await settle() // let the single-flight `finally` clear `inflight`.

  const failed = await batouStatus(NO_PATH)
  expect(failed.status).toBe("failed")
  // Sanitized: a human reason, never a URL or filesystem path.
  expect(failed.detail).toBe("checksum verification failed")
  expect(failed.detail).not.toContain("http")
  expect(failed.detail).not.toContain("/")

  // Within the backoff window a subsequent ensure must not re-fetch.
  await ensureBatouBinary(opts)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect((await batouStatus(NO_PATH)).status).toBe("failed")
})

test("batouStatus surfaces a sanitized HTTP reason on a failed fetch", async () => {
  const fetchImpl = mock(async () => jsonResponse(new Uint8Array(), 503))
  await ensureBatouBinary({
    env: NO_PATH,
    platform: "linux",
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: () => {},
  })
  await settle()
  const status = await batouStatus(NO_PATH)
  expect(status.status).toBe("failed")
  expect(status.detail).toBe("download failed (HTTP 503)")
  expect(status.detail).not.toContain("http:")
  expect(status.detail).not.toContain("//")
})

test("concurrent ensure calls share one status and one fetch", async () => {
  let release: (response: Response) => void = () => {}
  const gate = new Promise<Response>((resolve) => (release = resolve))
  const fetchImpl = mock(() => gate)
  const opts = {
    env: NO_PATH,
    platform: "linux" as const,
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: () => {},
  }

  const a = ensureBatouBinary(opts)
  const b = ensureBatouBinary(opts)
  await settle()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(await batouStatus(NO_PATH)).toEqual({ status: "downloading" })

  release(jsonResponse(new TextEncoder().encode("mismatch")))
  expect(await Promise.all([a, b])).toEqual([undefined, undefined])
})

test("beginBatouDownload clears the failure backoff so an explicit re-enable retries", async () => {
  const fetchImpl = mock(async () => jsonResponse(new TextEncoder().encode("mismatch")))
  const opts = {
    env: NO_PATH,
    platform: "linux" as const,
    arch: "x64",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: () => {},
  }

  // First attempt fails and arms the backoff.
  await ensureBatouBinary(opts)
  await settle()
  expect((await batouStatus(NO_PATH)).status).toBe("failed")
  expect(fetchImpl).toHaveBeenCalledTimes(1)

  // A passive ensure stays backed off (no new fetch)…
  await ensureBatouBinary(opts)
  expect(fetchImpl).toHaveBeenCalledTimes(1)

  // …but an explicit (re)enable clears the backoff and re-fetches. The fetch is
  // dispatched synchronously, so the count advances before the run can settle.
  beginBatouDownload(opts)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  await settle()
  expect((await batouStatus(NO_PATH)).status).toBe("failed")
})
