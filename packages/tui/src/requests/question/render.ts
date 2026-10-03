import { display } from "../../messages"
import { label } from "../../state"
import { answers, text, type QuestionFlow } from "./flow"
import { renderQuestionPage } from "./page"

/** Rebuilds the dialog body for the current page, the review screen, or the reject confirmation. */
export function render(flow: QuestionFlow) {
  const { dialog, questions } = flow
  flow.input = undefined
  flow.picker = undefined
  dialog.fields = []
  dialog.index = 0
  for (const child of dialog.form.getChildren()) child.destroyRecursively()
  dialog.form.scrollTo(0)
  dialog.error.height = 3
  flow.heading.content = flow.reject
    ? "Reject question request?"
    : flow.review
      ? "Review answers"
      : `Question ${flow.page + 1} of ${questions.length} · ${label(questions[flow.page]?.header ?? "", 80)}`
  if (flow.reject) renderReject(flow)
  else if (flow.review) renderReview(flow)
  else {
    const question = questions[flow.page]
    if (question) renderQuestionPage(flow, question)
    else renderEmpty(flow)
  }
  flow.ctx.dialogs.resize()
}

function renderReject(flow: QuestionFlow) {
  text(flow, "No answers will be sent. Ctrl+S confirms rejection; Ctrl+R returns to your answers.")
  flow.dialog.error.content = "Ctrl+S Confirm rejection\nCtrl+R Answer instead\nCtrl+K Sessions · Esc close"
  flow.dialog.form.focus()
}

function renderReview(flow: QuestionFlow) {
  answers(flow).forEach((answer, index) => {
    text(flow, `${index + 1}. ${display(flow.questions[index]!.question)}`)
    text(flow, answer.map((value) => `• ${display(value)}`).join("\n"), true)
  })
  text(flow, "[ Submit answers — Enter / Ctrl+S ]", true).onMouseDown = (event) => {
    event.preventDefault()
    if (event.button === 0 && !flow.dialog.busy) void flow.ctx.dialogs.submit()
  }
  flow.dialog.error.content =
    "Enter / Ctrl+S Submit answers\n← Edit · PgUp/PgDn Scroll\nCtrl+K Sessions · Ctrl+R Reject · Esc close"
  flow.dialog.form.focus()
}

function renderEmpty(flow: QuestionFlow) {
  text(flow, "This request has no questions. Close or reject it.")
  flow.dialog.error.content = "Ctrl+R Reject · Esc close"
  flow.dialog.form.focus()
}
