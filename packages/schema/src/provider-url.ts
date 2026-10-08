export * as ProviderURL from "./provider-url"

// Which provider base URLs the session runner will call, so a client can refuse one before saving it.
// No imports: `@turenlabs/client/provider-url` re-exports this for clients that do not load `effect`.

/**
 * HTTPS, or HTTP on loopback or a private (RFC 1918) IPv4 address. Credentials and fragments are
 * refused on either.
 */
export function qualified(value: string | undefined) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password || url.hash) return false
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") return true
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) return false
  const octets = url.hostname.split(".").map(Number)
  if (octets.some((octet) => octet > 255)) return false
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}
