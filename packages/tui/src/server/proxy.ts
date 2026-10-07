const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"]

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
