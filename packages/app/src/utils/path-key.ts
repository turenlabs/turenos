export type PathKey = string & { _brand: "PathKey" }

const isDriveQualified = (value: string) => {
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

// On Windows the same directory arrives through several spellings: realpath'd
// (`C:\Foo`), as reported by git or typed by the user (`c:\foo`, `C:/Foo`), or
// extended-length (`\\?\C:\Foo`, `\\?\UNC\server\share`). `\\?\` and `\\.\` are
// prefixes, not part of the path, so they must not participate in identity.
export const stripNtPrefix = (value: string) => {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`
  if (value.startsWith("\\\\?\\")) return value.slice(4)
  if (value.startsWith("\\\\.\\")) return value.slice(4)
  if (value.startsWith("\\??\\")) return value.slice(4)
  return value
}

export const pathKey = (path: string) => {
  const normalized = stripNtPrefix(path)
  const value = isWindowsPath(normalized) ? normalized.replaceAll("\\", "/") : normalized
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  // Drive-qualified paths are case-insensitive on NTFS. UNC spellings keep
  // their case because some providers (notably `\\wsl$`) are case-sensitive.
  if (!isDriveQualified(trimmed)) return trimmed as PathKey
  const lowered = trimmed.toLowerCase()
  return (lowered.length === 2 ? `${lowered}/` : lowered) as PathKey
}
