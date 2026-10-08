import { absolutePath, encodeFilePath, isAbsolutePath } from "@turenlabs/client/paths"

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
const mention = /(^|[\s([{"'])@(?:"([^"\u0000-\u001f\u007f-\u009f]{1,4096})"(#\d+(?:-\d+)?)?(?!#)|([^\s()[\]{}"'`]+))/g
const hazard = /^[^\s()[\]{}"'`]+$/
// A bare `file#5-` or `file#a-b` is a malformed range, not a file whose name ends that way.
const malformedRange = /#(?:\d*|\w*-[\w-]*)$/

/** Paths a finished file search found nothing for; such a mention stays text instead of becoming an attachment. */
const missing = new Set<string>()

/** Records what the server's file search answered for `query`, so a path it never resolved is not attached. */
export function recordSearch(directory: string, query: string, found: boolean) {
  if (!query || query.endsWith("/") || isAbsolutePath(query) || escapes(query)) return
  const key = `${directory}\0${query}`
  if (found) missing.delete(key)
  else missing.add(key)
  if (missing.size > 256) missing.delete(missing.values().next().value!)
}

/**
 * Mentions become native `prompt.files` parts, so the server reads the file and
 * slices any `?start=&end=` range at materialization time. This client never
 * opens the path itself, which is what lets it address files on a remote server.
 */
export function parseMentions(text: string, directory: string): PromptFile[] {
  return mentionReport(text, directory).files
}

/** The attachments a text produces, plus the mention texts whose path leaves the session directory. */
export function mentionReport(text: string, directory: string) {
  const seen = new Set<string>()
  const found = [...text.matchAll(mention)]
    .flatMap((match) => decodeMention(match, directory) ?? [])
    .filter((item) => !seen.has(item.file.uri) && seen.add(item.file.uri))
    .slice(0, 32)
  const attached = found.filter((item) => !item.unresolved)
  return {
    files: attached.map((item) => item.file),
    outside: attached.filter((item) => item.outside).map((item) => item.file.source.text),
    unresolved: found.filter((item) => item.unresolved).map((item) => item.file.source.text),
  }
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
  const bare = hazard.test(path) && !/[.,!?;:]$/.test(path) && !malformedRange.test(path)
  return bare ? `@${path}` : `@"${path}"`
}

function decodeMention(match: RegExpExecArray, directory: string) {
  const quoted = match[2] !== undefined
  const token = quoted ? match[2]! : match[4]!.replace(/[.,!?;:]+$/, "")
  const split = quoted ? undefined : /^(.+?)(#\d+(?:-\d+)?)$/.exec(token)
  const path = split ? split[1]! : token
  const query = lineQuery(quoted ? match[3] : split?.[2])
  if (!path || path.length > 4096 || query === undefined) return undefined
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return undefined
  if (!quoted && !split && malformedRange.test(path)) return undefined
  const uri = fileURI(absolutePath(directory, path), query)
  if (!uri) return undefined
  const text = quoted ? match[0].slice(match[1]!.length) : `@${token}`
  const offset = match.index + match[1]!.length
  const file: PromptFile = {
    uri,
    name: path.split(/[\\/]/).at(-1) || path,
    source: { start: offset, end: offset + text.length, text },
  }
  return { file, outside: escapes(path), unresolved: missing.has(`${directory}\0${path}`) }
}

/** An absolute path, `~`, or a `..` segment reaches outside the directory the session works in. */
function escapes(path: string) {
  return isAbsolutePath(path) || path.startsWith("~") || path.split(/[\\/]/).includes("..")
}

// A lone surrogate cannot be percent-encoded; such a mention stays plain text instead of failing the send.
function fileURI(path: string, query: string) {
  try {
    return `file://${encodeFilePath(path)}${query}`
  } catch {
    return undefined
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
