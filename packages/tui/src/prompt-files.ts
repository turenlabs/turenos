export type PromptFile = {
  uri: string
  name: string
  source: { start: number; end: number; text: string }
}

/**
 * A mention is `@path` or `@"path"`, each optionally followed by `#start-end`.
 * The quoted form exists because real paths contain spaces, brackets, and `#`,
 * all of which end a bare mention; completing such a path unquoted would attach
 * a shorter — possibly different — file. A leading delimiter keeps email
 * addresses and `a@b` from becoming attachments.
 */
const mention = /(^|[\s([{"'])@(?:"([^"\u0000-\u001f\u007f-\u009f]{1,4096})"(#\d+(?:-\d+)?)?|([^\s()[\]{}"'`]+))/g
const hazard = /^[^\s()[\]{}"'`]+$/

/**
 * Mentions become native `prompt.files` parts, so the server reads the file and
 * slices any `?start=&end=` range at materialization time. This client never
 * opens the path itself, which is what lets it address files on a remote server.
 */
export function parseMentions(text: string, directory: string): PromptFile[] {
  const seen = new Set<string>()
  return [...text.matchAll(mention)]
    .flatMap((match) => decodeMention(match, directory) ?? [])
    .filter((file) => !seen.has(file.uri) && seen.add(file.uri))
    .slice(0, 32)
}

// A prompt without mentions keeps its original body, so ordinary messages and
// their retries stay byte-identical to what earlier servers already accept.
export function promptPayload(text: string, directory: string) {
  const files = parseMentions(text, directory)
  return files.length ? { text, files } : { text }
}

/**
 * The mention text that parses back to exactly this path. Completion must use
 * it rather than inserting a raw path, and returns nothing for a path this
 * grammar cannot represent, so a wrong file is never attached silently.
 */
export function mentionText(path: string) {
  if (path.includes('"') || /[\u0000-\u001f\u007f-\u009f]/.test(path)) return undefined
  const bare = hazard.test(path) && !/[.,!?;:]$/.test(path) && !/#\d+(?:-\d+)?$/.test(path)
  return bare ? `@${path}` : `@"${path}"`
}

function decodeMention(match: RegExpExecArray, directory: string): PromptFile | undefined {
  const quoted = match[2] !== undefined
  const token = quoted ? match[2]! : match[4]!.replace(/[.,!?;:]+$/, "")
  const split = quoted ? undefined : /^(.+?)(#\d+(?:-\d+)?)$/.exec(token)
  const path = split ? split[1]! : token
  const query = lineQuery(quoted ? match[3] : split?.[2])
  if (!path || path.length > 4096 || query === undefined) return undefined
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return undefined
  const text = quoted ? match[0].slice(match[1]!.length) : `@${token}`
  const offset = match.index + match[1]!.length
  return {
    uri: `file://${encodePath(absolute(directory, path))}${query}`,
    name: path.split(/[\\/]/).at(-1) || path,
    source: { start: offset, end: offset + text.length, text },
  }
}

// An absent range is an empty query; a malformed one rejects the whole mention
// rather than silently attaching the entire file.
function lineQuery(range: string | undefined) {
  if (!range) return ""
  const parts = /^#(\d+)(?:-(\d+))?$/.exec(range)
  if (!parts) return undefined
  const start = Number(parts[1])
  const end = parts[2] === undefined ? start : Number(parts[2])
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) return undefined
  return `?start=${start}&end=${end}`
}

function absolute(directory: string, path: string) {
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

// Windows drive paths become `/C:/...` so the server's file URL parser keeps the
// drive; the colon must survive segment encoding for that to work.
function encodePath(path: string) {
  const normalized = path.replace(/\\/g, "/")
  return (/^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized)
    .split("/")
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")
}
