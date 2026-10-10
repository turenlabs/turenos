import { label } from "../state"

const MIN = 8

/**
 * The text beside a server's name. An address that only repeats the name is dropped, and each ` · ` part is cut on its
 * own (a path loses its start, other text its end) so a command is never joined to a path by one ellipsis.
 */
export function fitDetail(name: string, detail: string, space: number) {
  if (detail.replace(/^https?:\/\//, "") === name) return ""
  const parts = detail.split(" · ")
  const joined = () => parts.join(" · ")
  while (joined().length > space) {
    const at = parts.reduce((best, part, index) => (part.length > parts[best]!.length ? index : best), 0)
    const target = Math.max(MIN, parts[at]!.length - (joined().length - space))
    const next = shorten(parts[at]!, target)
    if (next.length >= parts[at]!.length) return label(joined(), Math.max(1, space))
    parts[at] = next
  }
  return joined()
}

function shorten(part: string, size: number) {
  const space = part.lastIndexOf(" ") + 1
  const word = part.slice(space)
  if (!word.includes("/")) return label(part, size)
  const room = size - space
  return room < 2 ? label(part, size) : `${part.slice(0, space)}…${word.slice(word.length - room + 1)}`
}
