import { isIP } from "node:net"

export function classifyAddress(address: string): "loopback" | "lan" | "public" | "blocked" {
  const normalized =
    address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1).toLowerCase() : address.toLowerCase()
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number)
    if (a === 127) return "loopback"
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan"
    if (
      a === 0 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 192 && (b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    )
      return "blocked"
    return "public"
  }
  if (normalized === "::1") return "loopback"
  if (normalized === "::" || normalized.startsWith("::ffff:")) return "blocked"
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "lan"
  if (["fec", "fed", "fee", "fef"].some((prefix) => normalized.startsWith(prefix))) return "lan"
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("2002:")
  )
    return "blocked"
  return "public"
}
