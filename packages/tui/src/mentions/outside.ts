import { mentionReport } from "../prompt-files"

/**
 * A mention whose path leaves the session directory (absolute, `..` or `~`) needs a second, deliberate
 * send. `key` is the acknowledgement to remember; `message` is set while that key is not yet acknowledged.
 */
export function outsideNotice(text: string, directory: string, acknowledged: string | undefined) {
  const key = mentionReport(text, directory).outside.join(" ")
  if (!key || key === acknowledged) return { key }
  return {
    key,
    message: `This attaches files outside ${directory}: ${key}. Send again to attach them, or edit the mention.`,
  }
}

/** The one-line attachment list shown under an editor, with escaping paths flagged. */
export function attachmentSummary(text: string, directory: string) {
  const report = mentionReport(text, directory)
  if (!report.files.length) return undefined
  const names = report.files.map((file) => file.source.text.slice(1).replaceAll('"', "")).join(", ")
  return report.outside.length ? `Attaches ${names} · OUTSIDE ${directory}: ${report.outside.join(" ")}` : `Attaches ${names}`
}
