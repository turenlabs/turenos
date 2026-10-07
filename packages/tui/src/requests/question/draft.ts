import type { DashboardState } from "../../state"
import type { QuestionDraft, RequestContext } from "../context"
import type { Questions } from "./flow"

/** Reuses the saved draft only while the server's questions are unchanged. */
export function loadDraft(ctx: RequestContext, key: string, questions: Questions) {
  const signature = JSON.stringify(
    questions.map((item) => [
      item.header,
      item.question,
      item.multiple,
      item.custom,
      item.options.map((option) => [option.label, option.description]),
    ]),
  )
  const previous = ctx.questionDrafts.get(key)
  const draft: QuestionDraft =
    previous?.signature === signature
      ? previous
      : {
          signature,
          selections: questions.map(() => new Set<number>()),
          custom: questions.map(() => ""),
          customOn: questions.map(() => false),
          cursors: questions.map(() => 0),
          page: 0,
          review: false,
          reject: false,
          editing: false,
          cursor: 0,
        }
  ctx.questionDrafts.delete(key)
  ctx.questionDrafts.set(key, draft)
  if (ctx.questionDrafts.size > 16) ctx.questionDrafts.delete(ctx.questionDrafts.keys().next().value!)
  return draft
}

/** Drops the drafts of the shown session's questions that are no longer pending, whether or not their dialog is open. */
export function sweepDrafts(state: DashboardState, drafts: Map<string, QuestionDraft>) {
  const detail = state.detail
  if (!detail) return
  const live = new Set(detail.questions.map((item) => `${item.sessionID}:${item.id}`))
  for (const key of drafts.keys())
    if (key.startsWith(`${detail.sessionID}:`) && !live.has(key) && state.modal?.questionKey !== key) drafts.delete(key)
}
