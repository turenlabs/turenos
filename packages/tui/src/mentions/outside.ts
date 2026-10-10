import { mentionReport, type MentionScope, type PromptFile } from "../prompt-files"
import { active } from "./popup"

/**
 * A mention whose path leaves the session directory (absolute, `..` or `~`) needs a second, deliberate
 * send. `key` is the acknowledgement to remember; `message` is set while that key is not yet acknowledged.
 */
export function outsideNotice(text: string, directory: string, acknowledged: string | undefined, scope?: MentionScope) {
  const key = mentionReport(text, directory, scope).outside.join(" ")
  if (!key || key === acknowledged) return { key }
  return {
    key,
    message: `This attaches files outside ${directory}: ${key}. Send again to attach them, or edit the mention.`,
  }
}

/** The one-line attachment list shown under an editor, with escaping paths flagged. */
export function attachmentSummary(text: string, directory: string, scope?: MentionScope, frozenFiles?: PromptFile[]) {
  // A leading `!` makes the whole message a shell command, which attaches nothing.
  if (/^!./s.test(text)) return "Shell command · Enter runs it on the server (Steer only)"
  const report = mentionReport(text, directory, scope)
  const files = frozenFiles ?? report.files
  const outside = report.outside.filter((text) => files.some((file) => file.source.text === text))
  const unresolved =
    frozenFiles === undefined && report.unresolved.length
      ? `No file matches ${report.unresolved.join(" ")}; it stays as text and is not attached`
      : undefined
  if (!files.length) return unresolved
  const names = files.map((file) => file.source.text.slice(1).replaceAll('"', "")).join(", ")
  const attaches = outside.length
    ? `Attaches ${names} · OUTSIDE ${directory}: ${outside.join(" ")}`
    : `Attaches ${names}`
  return unresolved ? `${attaches} · ${unresolved}` : attaches
}

/** The text without the `@token` ending at the cursor, which is only a search while the suggestion list is open. */
export function withoutOpenMention(text: string, cursor: number) {
  const prefix = active.exec(text.slice(0, cursor))
  if (!prefix) return text
  const start = cursor - prefix[0].length + prefix[0].indexOf("@")
  return text.slice(0, start) + text.slice(cursor)
}
