import { clean, quote } from "./context"
import type { Pending } from "./state"

type Permission = Pending["permissions"][number]
type Question = Pending["questions"][number]

/** The pending requests as labelled lines, each followed by the exact commands that resolve it. */
export function requestsText(pending: Pending, flags: string) {
  return [
    ...pending.permissions.map((request) => permissionText(request, flags)),
    ...pending.questions.map((request) => questionText(request, flags)),
  ].join("\n")
}

function permissionText(request: Permission, flags: string) {
  const command = (verb: string) => `turen-tui ${verb} ${request.sessionID} ${request.id}${flags}`
  const target = request.resources.map((resource) => clean(resource, 1000)).join(", ")
  const save = request.save?.length
    ? `        (add --always to save: ${request.save.map((pattern) => clean(pattern, 200)).join(", ")})`
    : ""
  return [
    `permission ${request.id} · session ${request.sessionID} · ${[clean(request.action), target].filter(Boolean).join(" · ")}`,
    `  approve: ${command("approve")}${save}`,
    `  reject:  ${command("reject")}`,
  ].join("\n")
}

function questionText(request: Question, flags: string) {
  const prefix = `question ${request.id} · session ${request.sessionID}`
  const command = `turen-tui answer ${request.sessionID} ${request.id}${flags}`
  if (request.questions.length === 1) {
    const item = request.questions[0]!
    const first = item.options[0] ? clean(item.options[0].label, 200) : "<your answer>"
    return [
      `${prefix} · ${clean(item.header, 80)}: ${clean(item.question, 800)}`,
      optionsLine(item),
      `  answer:  ${command} --choice=${quote(first)}`,
    ].join("\n")
  }
  const suggestion = JSON.stringify(
    request.questions.map((item) => [item.options[0] ? clean(item.options[0].label, 200) : "<your answer>"]),
  )
  return [
    `${prefix} · ${request.questions.length} questions`,
    ...request.questions.flatMap((item, index) => [
      `  ${index + 1}. ${clean(item.header, 80)}: ${clean(item.question, 800)}`,
      `  ${optionsLine(item)}`,
    ]),
    `  answer:  ${command} --answers=${quote(suggestion)}`,
  ].join("\n")
}

function optionsLine(item: Question["questions"][number]) {
  const notes = [
    item.multiple ? "several may be chosen" : "",
    item.custom !== false ? "a custom answer is accepted" : "",
  ].filter(Boolean)
  const labels = item.options.map((option) => clean(option.label, 200)).join(" | ")
  return `  options: ${labels || "(none)"}${notes.length ? ` (${notes.join("; ")})` : ""}`
}
