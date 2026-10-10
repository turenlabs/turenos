import { TextRenderable } from "@opentui/core"
import type { ModalState } from "../state"
import { color } from "../theme"
import type { RequestContext } from "./context"
import { loadDraft } from "./question/draft"
import { answers, complete, keepCustom, type QuestionFlow, type Questions } from "./question/flow"
import { beforeSubmit, handleKey, handleTab } from "./question/keys"
import { render } from "./question/render"

type Request = NonNullable<RequestContext["state"]["detail"]>["questions"][number]

export function question(ctx: RequestContext, reject = false) {
  const request = ctx.state.detail?.questions[0]
  if (!request || ctx.state.detail?.sessionID !== ctx.state.selected || request.sessionID !== ctx.state.selected)
    return ctx.say("No pending question for the selected session.")
  const dialog = ctx.dialogs.open("Answer agent", false, 16, true)
  if (!dialog) return
  const key = `${request.sessionID}:${request.id}`
  dialog.questionKey = key
  dialog.recipient = ctx.state.snapshot?.sessions.find((session) => session.id === request.sessionID)
  trackShown(ctx, key)
  dialog.onNavigate = () => ctx.shownQuestions.delete(key)
  dialog.refresh = () => closeWhenResolved(ctx, dialog, request, key)
  const flow = createFlow(ctx, dialog, request.questions, loadDraft(ctx, key, request.questions), reject)
  dialog.frame.add(flow.heading, 0)
  dialog.save = () => {
    keepCustom(flow)
    Object.assign(flow.draft, { page: flow.page, review: flow.review, reject: flow.reject, editing: !!flow.input })
  }
  dialog.key = (event) => handleKey(flow, event)
  dialog.tab = (back) => handleTab(flow, back)
  dialog.beforeSubmit = () => beforeSubmit(flow)
  dialog.submit = () => submitQuestion(flow, request, key)
  render(flow)
}

function createFlow(
  ctx: RequestContext,
  dialog: ModalState,
  questions: Questions,
  draft: QuestionFlow["draft"],
  reject: boolean,
) {
  const flow: QuestionFlow = {
    ctx,
    dialog,
    questions,
    draft,
    heading: new TextRenderable(ctx.renderer, {
      content: "",
      fg: color.accent,
      height: 1,
      flexShrink: 0,
      truncate: true,
      wrapMode: "none",
    }),
    page: draft.page,
    review: draft.review,
    reject: reject || draft.reject,
    render: () => render(flow),
    // The closed dialog saved the draft; back from the rejection confirmation resumes the answers, not the rejection.
    reopen: () => {
      draft.reject = false
      question(ctx)
    },
  }
  return flow
}

function closeWhenResolved(ctx: RequestContext, dialog: ModalState, request: Request, key: string) {
  if (
    ctx.state.modal === dialog &&
    !dialog.busy &&
    ctx.state.detail?.sessionID === request.sessionID &&
    !ctx.state.detail.questions.some((item) => item.id === request.id)
  ) {
    ctx.questionDrafts.delete(key)
    ctx.dialogs.close(false)
    ctx.say("Question is no longer pending.")
  }
}

async function submitQuestion(flow: QuestionFlow, request: Request, key: string) {
  const { ctx } = flow
  if (flow.reject) {
    await ctx.connection.client.questions.reject({ sessionID: request.sessionID, requestID: request.id })
    ctx.questionDrafts.delete(key)
    ctx.say("Question rejected.")
    return
  }
  if (!flow.review || flow.input || !complete(flow))
    throw new Error("Answer every question and review before submitting.")
  await ctx.connection.client.questions.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    answers: answers(flow),
  })
  ctx.questionDrafts.delete(key)
  ctx.say("Answers sent.")
}

function trackShown(ctx: RequestContext, key: string) {
  ctx.shownQuestions.add(key)
  if (ctx.shownQuestions.size > 256) ctx.shownQuestions.delete(ctx.shownQuestions.values().next().value!)
}
