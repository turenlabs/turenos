// File paths as the server reads them in `file://` attachment URLs, shared by the desktop app and
// the terminal client. Keep this file framework-free.

/** A path resolved against `directory` unless it is already a POSIX, UNC or Windows drive path. */
export function absolutePath(directory: string, path: string) {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

/**
 * The URL path of `filepath`, each segment percent-encoded. Windows drive paths become `/C:/...`,
 * keeping the colon, so the server's file URL parser can still find the drive.
 */
export function encodeFilePath(filepath: string): string {
  if (!/[^-A-Za-z0-9._~/]/.test(filepath)) return filepath
  const normalized = filepath.replace(/\\/g, "/")
  return (/^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized)
    .split("/")
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")
}
