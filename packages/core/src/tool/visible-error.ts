export * as ToolVisibleError from "./visible-error"

export const MAX_LENGTH = 4_096

export function make(value: unknown) {
  const source = value instanceof Error ? value.message : String(value)
  const redacted = source
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
    .trim()
  if (redacted.length <= MAX_LENGTH) return redacted || "Tool execution failed"
  return `${redacted.slice(0, MAX_LENGTH - 22)}… [error truncated]`
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
