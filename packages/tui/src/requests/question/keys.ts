import type { KeyEvent } from "@opentui/core"
import { matchesKey } from "../../keys"
import { advance, complete, keepCustom, type QuestionFlow } from "./flow"
import { render } from "./render"

export function handleKey(flow: QuestionFlow, key: KeyEvent) {
  if (matchesKey(key, "r", { ctrl: true })) {
    keepCustom(flow)
    flow.reject = !flow.reject
    render(flow)
    return true
  }
  if (flow.reject) return matchesKey(key, "enter")
  if (flow.input) return handleCustomKey(flow, key)
  if (matchesKey(key, "left")) return previous(flow)
  if (matchesKey(key, "right") && !flow.review) {
    advance(flow)
    return true
  }
  if (matchesKey(key, "enter")) {
    if (flow.review) void flow.ctx.dialogs.submit()
    else flow.picker?.selectCurrent()
    return true
  }
  return false
}

/**
 * Tab and Shift+Tab move between the questions as → and ← do. While a custom answer is typed, or the request is
 * being rejected, Tab keeps moving between the fields.
 */
export function handleTab(flow: QuestionFlow, back: boolean) {
  if (flow.reject || flow.input) return false
  if (back) return previous(flow)
  if (!flow.review) advance(flow)
  return true
}

function previous(flow: QuestionFlow) {
  if (flow.review) flow.review = false
  else flow.page = Math.max(0, flow.page - 1)
  render(flow)
  return true
}

function handleCustomKey(flow: QuestionFlow, key: KeyEvent) {
  const { custom, customOn, selections } = flow.draft
  if (matchesKey(key, "b", { ctrl: true })) {
    keepCustom(flow)
    render(flow)
    return true
  }
  if (!matchesKey(key, "enter")) return false
  keepCustom(flow)
  if (!custom[flow.page]!.trim()) {
    flow.dialog.error.content = "Enter a non-empty answer.\nCtrl+B back to choices · Esc close"
    return true
  }
  customOn[flow.page] = true
  if (!flow.questions[flow.page]!.multiple) {
    selections[flow.page]!.clear()
    advance(flow)
  } else render(flow)
  return true
}

// Shared submission shortcuts run before dialog.key. Never let them skip
// unanswered questions, an uncommitted custom entry, or the review screen.
export function beforeSubmit(flow: QuestionFlow) {
  if (flow.reject || flow.review) return false
  if (flow.input) {
    flow.dialog.error.content = "Press Enter to save your custom answer first.\nEsc close"
    return true
  }
  if (!complete(flow)) {
    flow.dialog.error.content = "Answer every question before reviewing.\n←/→ Navigate · Esc close"
    return true
  }
  flow.review = true
  render(flow)
  return true
}
