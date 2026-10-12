import { Team } from "@turenlabs/schema/team"
import { ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export type TeamAttachment = Team.Attachment

export const TEAM_ATTACHMENT_LIMIT = Team.MAX_ATTACHMENTS
export const TEAM_ATTACHMENT_BYTES = Team.MAX_ATTACHMENT_BYTES
export const TEAM_ATTACHMENT_TOTAL_BYTES = Team.MAX_ATTACHMENT_TOTAL_BYTES

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
// Raster formats cannot run script or load subresources. SVG and HTML can, so they never render inline.
const INLINE = new Set(ACCEPTED_IMAGE_TYPES)

export function teamAttachmentProblem(current: readonly { size: number }[], file: { name: string; size: number }) {
  if (current.length >= TEAM_ATTACHMENT_LIMIT)
    return `You can attach up to ${TEAM_ATTACHMENT_LIMIT} files to a message.`
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > TEAM_ATTACHMENT_BYTES) return `${file.name} is larger than 10 MiB.`
  if (current.reduce((total, item) => total + item.size, file.size) > TEAM_ATTACHMENT_TOTAL_BYTES)
    return "Attachments on one message can total up to 20 MiB."
}

export function teamAttachmentMime(mime: string) {
  return MIME.test(mime) ? mime : "application/octet-stream"
}

/** Decoded byte length, or undefined unless the URI is strict base64 of the declared type. */
export function teamAttachmentSize(attachment: TeamAttachment) {
  const payload = strictPayload(attachment)
  if (payload === undefined) return
  return (payload.length / 4) * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0)
}

export function teamAttachmentInline(attachment: TeamAttachment) {
  if (!INLINE.has(attachment.mime) || strictPayload(attachment) === undefined) return
  return attachment.uri
}

/** Downloads never keep the declared type, so a saved file cannot open as active content in the app origin. */
export function teamAttachmentBlob(attachment: TeamAttachment) {
  const payload = strictPayload(attachment)
  if (payload === undefined) return
  return new Blob([Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))], { type: "application/octet-stream" })
}

function strictPayload(attachment: TeamAttachment) {
  const prefix = `data:${attachment.mime};base64,`
  if (!MIME.test(attachment.mime) || !attachment.uri.startsWith(prefix)) return
  const payload = attachment.uri.slice(prefix.length)
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) return
  return payload
}
