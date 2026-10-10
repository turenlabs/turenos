const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"]

/** The origin a server on a Unix socket calls itself (forge's own listener URL); requests still go to the socket. */
export const SOCKET_ORIGIN = "http://localhost"

/** The fetch options that reach a server listening on a Unix socket; none for a server on a TCP port. */
export function dial(socketPath: string | undefined) {
  return socketPath ? { unix: socketPath } : {}
}

/**
 * Bun's fetch reads NO_PROXY at request time, and an empty proxy option still uses shell proxies.
 * Keep local credentials direct and retain the other rules; a no-op for any other host.
 */
export function bypassLoopbackProxy(url: URL) {
  if (!LOOPBACK.includes(url.hostname)) return
  const bypass = [process.env.NO_PROXY ?? "", process.env.no_proxy ?? "", "127.0.0.1,localhost,::1,[::1]"]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
  process.env.NO_PROXY = [...new Set(bypass)].join(",")
  process.env.no_proxy = process.env.NO_PROXY
}
