import { TextRenderable, type InputRenderable, type SelectRenderable } from "@opentui/core"
import type { ModalState } from "../../state"
import { color } from "../../theme"
import type { QuestionDraft, RequestContext } from "../context"

export type Questions = NonNullable<RequestContext["state"]["detail"]>["questions"][number]["questions"]

/** The live state of one open question dialog. `draft` outlives it so a closed dialog can be resumed. */
export type QuestionFlow = {
  ctx: RequestContext
  dialog: ModalState
  questions: Questions
  draft: QuestionDraft
  heading: TextRenderable
  page: number
  review: boolean
  reject: boolean
  input?: InputRenderable
  picker?: SelectRenderable
  /** Repaints the dialog for the current page; set by the opener so these helpers do not import the renderer. */
  render: () => void
  /** Reopens the question dialog on the answers; set by the opener, which owns the dialog's lifecycle. */
  reopen: () => void
}

export function answers(flow: QuestionFlow) {
  const { selections, custom, customOn } = flow.draft
  return flow.questions.map((question, index) =>
    [
      ...question.options.filter((_, option) => selections[index]!.has(option)).map((option) => option.label),
      ...(customOn[index] && custom[index]!.trim() ? [custom[index]!.trim()] : []),
    ].filter((answer, index, values) => values.indexOf(answer) === index),
  )
}

export function complete(flow: QuestionFlow) {
  return flow.questions.length > 0 && answers(flow).every((answer) => answer.length > 0)
}

export function text(flow: QuestionFlow, content: string, accent = false) {
  const node = new TextRenderable(flow.ctx.renderer, {
    content,
    fg: accent ? color.accent : color.text,
    wrapMode: "word",
    flexShrink: 0,
  })
  flow.dialog.form.add(node)
  return node
}

export function keepCustom(flow: QuestionFlow) {
  if (!flow.input) return
  flow.draft.custom[flow.page] = flow.input.value
  flow.draft.cursor = flow.input.cursorOffset
}

export function editCustom(flow: QuestionFlow, restore = false) {
  if (flow.input) return flow.input.focus()
  const input = flow.ctx.dialogs.input(flow.dialog, "Your answer", flow.draft.custom[flow.page], "Type your answer")
  flow.input = input
  if (restore) input.cursorOffset = Math.min(flow.draft.cursor, input.plainText.length)
  flow.dialog.error.content = "Enter Save custom answer\nCtrl+B Back to choices\nCtrl+K Sessions · Esc close"
  flow.ctx.dialogs.resize()
  input.focus()
}

export function advance(flow: QuestionFlow) {
  if (!answers(flow)[flow.page]?.length) {
    flow.dialog.error.content = "Choose an answer before continuing.\nEsc close · Ctrl+R Reject request"
    return
  }
  if (flow.page < flow.questions.length - 1) flow.page++
  else if (complete(flow)) flow.review = true
  else flow.page = answers(flow).findIndex((answer) => !answer.length)
  flow.render()
}
