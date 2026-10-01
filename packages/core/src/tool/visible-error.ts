export * as ToolVisibleError from "./visible-error"

import { SecretRedaction } from "../secret-redaction"

export const MAX_LENGTH = 4_096

/**
 * `protect` masks configured values and detected formats on the complete original message. The
 * substitutions and length cap below then run only between the references it produced: applied
 * first, they rewrote part of a configured value (a composite's `AKIA…` half) so the guard could no
 * longer match the whole, and the cap could cut a credential before the guard saw it.
 */
export function make(value: unknown, protect: (text: string) => string = (text) => text) {
  const source = protect(value instanceof Error ? value.message : String(value))
  const segments: string[] = []
  let offset = 0
  for (const reference of SecretRedaction.references(source)) {
    segments.push(substitute(source.slice(offset, reference.start)), source.slice(reference.start, reference.end))
    offset = reference.end
  }
  segments.push(substitute(source.slice(offset)))
  const redacted = segments.join("").trim()
  if (redacted.length <= MAX_LENGTH) return redacted || "Tool execution failed"
  const limit = MAX_LENGTH - 22
  // Never leave half a reference behind the cut.
  const cut =
    SecretRedaction.references(redacted).find((reference) => reference.start < limit && reference.end > limit)?.start ??
    limit
  return `${redacted.slice(0, cut)}… [error truncated]`
}

function substitute(text: string) {
  return text
    .replace(
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi,
      "[redacted credential]",
    )
    .replace(/\b(Authorization\s*:\s*)(?:Bearer|Basic)\s+\S+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /(\b(?:api[_-]?key|authorization|password|secret|session[_-]?token|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "[redacted credential]",
    )
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, redactCredentialUrl)
    .replace(/\bfile:\/\/[^\s"'<>]+/gi, "[redacted path]")
    .replace(/\/Users\/[^/\s]+/g, "$HOME")
    .replace(/\/home\/[^/\s]+/g, "$HOME")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "$HOME")
    .replace(/(^|[\s("'`=:\[])\\\\(?:[^\s"'<>()[\]{}\\]+\\)+[^\s"'<>()[\]{}\\]+/gm, "$1[redacted path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, "[redacted path]")
    .replace(/(^|[\s("'`=:\[])\/(?!\/)(?:[^\s"'<>()[\]{}/]+\/)+[^\s"'<>()[\]{}/]+/gm, "$1[redacted path]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
}

function redactCredentialUrl(value: string) {
  try {
    const url = new URL(value)
    const secretQuery = [...url.searchParams.keys()].some((key) =>
      /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|signature|sig)$/i.test(
        key,
      ),
    )
    return url.username || url.password || secretQuery ? "[redacted credential URL]" : value
  } catch {
    return "[redacted malformed URL]"
  }
}
