// Local provider plugins accept user-configured endpoints, but only ever dial loopback. Anything
// else — remote hosts, credentials in the URL, non-HTTP schemes — is rejected so a "local" provider
// can never be pointed at a remote service.
export function normalizeLocalHttpEndpoint(value: unknown, fallback: string) {
  if (value !== undefined && value !== null && typeof value !== "string") return undefined
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback
  const candidate = raw.includes("://") ? raw : `http://${raw}`

  try {
    const url = new URL(candidate)
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.username || url.password || url.search || url.hash) return undefined

    const pathname = url.pathname.replace(/\/+$/, "")
    url.pathname = pathname.endsWith("/v1") ? pathname.slice(0, -3) || "/" : pathname || "/"
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}
